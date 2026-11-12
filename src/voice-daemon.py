#!/usr/bin/env python3
"""User-local capture broker. No credentials, disk audio, or network uploads.

Pulse's reported capture latency maps PCM frames to CLOCK_MONOTONIC, shared
with Node's hrtime on Linux. Hardware/server timestamp accuracy still applies.
"""
import base64
import collections
import ctypes as C
import fcntl
import io
import json
import math
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import wave

RATE = 16000
MAX_SECONDS = 180
PROTOCOL = 1


def configuration():
    try:
        with open(os.path.expanduser('~/.pi/mimo-voice-zh.json')) as f:
            cfg = json.load(f)
    except FileNotFoundError:
        cfg = {}
    return {k: cfg.get(k, v) for k, v in {
        'recordingDevice': '', 'recordingProcessing': 'none',
        'recordingBackend': 'auto', 'recordingWarmupMs': 1000,
    }.items()}


class AudioBuffer:
    def __init__(self):
        self.chunks = collections.deque()
        self.owner = None
        self.start = None
        self.end = None

    def clear(self):
        self.chunks.clear()
        self.owner = self.start = self.end = None

    def append(self, end, pcm):
        start = end - len(pcm) / (RATE * 2)
        self.chunks.append((start, end, pcm))
        keep = self.start if self.owner is not None else end - 3
        while self.chunks and self.chunks[0][1] < keep:
            self.chunks.popleft()
        if self.owner is not None and end - self.start > MAX_SECONDS + 5:
            self.clear()

    def begin(self, owner, at):
        if self.owner is not None:
            raise ValueError('麦克风正在被其他会话使用')
        if not self.chunks or at < self.chunks[0][0]:
            raise ValueError('录音开始时间已超出缓冲区，请重试')
        self.owner, self.start, self.end = owner, at, None

    def cancel(self, owner):
        if self.owner is owner:
            self.owner = self.start = self.end = None

    def extract(self, owner, end):
        if self.owner is not owner:
            raise ValueError('录音已取消（设备重连、超时或会话断开）')
        if not self.start < end <= self.start + MAX_SECONDS + 0.1:
            raise ValueError('无效录音时长')
        result = []
        for start, _, pcm in self.chunks:
            # Include only samples whose timestamps fall inside [F8, F8).
            first = max(0, math.ceil((self.start - start) * RATE))
            last = min(len(pcm) // 2, math.ceil((end - start) * RATE))
            if last > first:
                result.append(pcm[first * 2:last * 2])
        self.cancel(owner)
        data = b''.join(result)
        if not data:
            raise ValueError('录音为空')
        output = io.BytesIO()
        with wave.open(output, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(RATE)
            wav.writeframes(data)
        return base64.b64encode(output.getvalue()).decode('ascii')


class SampleSpec(C.Structure):
    _fields_ = [('format', C.c_int), ('rate', C.c_uint32), ('channels', C.c_uint8)]


class BufferAttr(C.Structure):
    _fields_ = [(n, C.c_uint32) for n in ('maxlength', 'tlength', 'prebuf', 'minreq', 'fragsize')]


class Pulse:
    def __init__(self, device):
        self.lib = C.CDLL('libpulse-simple.so.0')
        self.lib.pa_simple_new.argtypes = [C.c_char_p, C.c_char_p, C.c_int, C.c_char_p,
                                          C.c_char_p, C.POINTER(SampleSpec), C.c_void_p,
                                          C.POINTER(BufferAttr), C.POINTER(C.c_int)]
        self.lib.pa_simple_new.restype = C.c_void_p
        self.lib.pa_simple_read.argtypes = [C.c_void_p, C.c_void_p, C.c_size_t, C.POINTER(C.c_int)]
        self.lib.pa_simple_get_latency.argtypes = [C.c_void_p, C.POINTER(C.c_int)]
        self.lib.pa_simple_get_latency.restype = C.c_uint64
        self.lib.pa_simple_free.argtypes = [C.c_void_p]
        self.error = C.c_int()
        spec = SampleSpec(3, RATE, 1)  # PA_SAMPLE_S16LE
        attr = BufferAttr(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff, 640)
        self.stream = self.lib.pa_simple_new(None, b'Pi voice', 2,
                                            device.encode() if device else None, b'Voice capture',
                                            C.byref(spec), None, C.byref(attr), C.byref(self.error))
        if not self.stream:
            raise RuntimeError('无法连接麦克风 / PulseAudio；错误码 %s' % self.error.value)

    def read(self):
        data = C.create_string_buffer(640)  # 20ms
        if self.lib.pa_simple_read(self.stream, data, len(data), C.byref(self.error)) < 0:
            raise RuntimeError('麦克风读取失败：%s' % self.error.value)
        latency = self.lib.pa_simple_get_latency(self.stream, C.byref(self.error))
        if latency == 0xffffffffffffffff:
            raise RuntimeError('无法获取采集延迟')
        return time.monotonic() - latency / 1e6, data.raw

    def close(self):
        self.lib.pa_simple_free(self.stream)


def pactl(*args):
    return subprocess.check_output(['pactl', *args], timeout=5, env={**os.environ, 'LC_ALL': 'C'},
                                   stderr=subprocess.DEVNULL).decode().strip()


def source_for(cfg):
    info = pactl('info')
    def field(text, label):
        match = re.search(r'^\s*' + label + r':\s*(.+)$', text, re.M)
        return match.group(1).strip() if match else ''
    source = cfg['recordingDevice'] or field(info, 'Default Source')
    blocks = re.split(r'(?=^Source #)', pactl('list', 'sources'), flags=re.M)
    selected = next((s for s in blocks if field(s, 'Name') == source
                     or s.startswith('Source #' + source + '\n')), None)
    if selected is None or field(selected, 'Name').endswith('.monitor') or 'device.class = "monitor"' in selected:
        raise ValueError('请选择实际麦克风，不能使用系统声音回环')
    source = field(selected, 'Name')
    if field(selected, 'Mute') == 'yes':
        raise ValueError('麦克风已静音')
    if cfg['recordingProcessing'] == 'none':
        return source, None
    if cfg['recordingProcessing'] != 'webrtc':
        raise ValueError('recordingProcessing 只支持 none / webrtc')
    name = 'pi_mimo_daemon_' + str(os.getpid())
    def param(k, v):
        return k + '=\"' + v.replace('\\', '\\\\').replace('"', '\\"') + '\"'
    module = pactl('load-module', 'module-echo-cancel', param('source_master', source),
                   param('sink_master', field(info, 'Default Sink')), 'source_name=' + name,
                   'sink_name=' + name + '_sink', 'aec_method=webrtc', 'rate=48000',
                   'channels=1', 'use_volume_sharing=0',
                   param('aec_args', 'analog_gain_control=0 digital_gain_control=1 noise_suppression=1 high_pass_filter=1'))
    return name, module


class Broker:
    def __init__(self, cfg):
        self.cfg = cfg
        self.audio = AudioBuffer()
        self.condition = threading.Condition()
        self.ready = False
        self.error = '麦克风预热中'
        self.last = time.monotonic()

    def capture(self):
        while True:
            pulse = module = None
            try:
                if self.cfg['recordingBackend'] not in ('auto', 'parecord'):
                    raise ValueError('常驻模式只支持 PulseAudio；请设置 recordingBackend: auto')
                warmup = self.cfg['recordingWarmupMs']
                if type(warmup) is not int or not 0 <= warmup <= 3000:
                    raise ValueError('recordingWarmupMs 必须是 0–3000 的整数')
                source, module = source_for(self.cfg)
                pulse = Pulse(source)
                first = None
                previous_end = None
                sample_end = None
                while True:
                    end, pcm = pulse.read()
                    now = time.monotonic()
                    with self.condition:
                        # Suspend/overrun/discontinuity: discard the utterance, never splice it.
                        if previous_end is not None and (end - previous_end > .2 or end < previous_end - .02):
                            self.audio.clear()
                            first = None
                            sample_end = None
                        previous_end = end
                        # Keep frames contiguous; re-anchor only after a discontinuity.
                        sample_end = end if sample_end is None else sample_end + len(pcm) / (RATE * 2)
                        if abs(sample_end - end) > .1:
                            self.audio.clear()
                            first = None
                            sample_end = end
                        first = sample_end if first is None else first
                        self.audio.append(sample_end, pcm)
                        self.last = now
                        self.ready = sample_end - first >= warmup / 1000
                        self.error = '' if self.ready else '麦克风预热中'
                        self.condition.notify_all()
            except Exception as error:
                with self.condition:
                    self.ready = False
                    self.last = time.monotonic()
                    self.error = str(error)
                    self.audio.clear()
                    self.condition.notify_all()
            finally:
                if pulse:
                    pulse.close()
                if module:
                    try:
                        pactl('unload-module', module)
                    except Exception:
                        pass
                if self.cfg['recordingProcessing'] == 'webrtc':
                    cleanup_modules()  # Also recover a load that timed out after server-side success.
            time.sleep(2)

    def request(self, owner, req):
        with self.condition:
            op = req.get('op')
            if op == 'hello':
                if req.get('protocol') != PROTOCOL or req.get('config') != self.cfg:
                    raise ValueError('后台版本或麦克风配置不一致，请显式 /voice-daemon restart')
            ready = self.ready and time.monotonic() - self.last < 1
            if op in ('hello', 'status'):
                return {'ready': ready, 'error': self.error if not ready else '',
                        'busy': self.audio.owner is not None, 'owned': self.audio.owner is owner}
            if op == 'cancel':
                self.audio.cancel(owner)
                return {}
            if not ready:
                raise ValueError(self.error or '麦克风未就绪')
            at = req.get('at')
            if not isinstance(at, (int, float)) or not math.isfinite(at) or not 0 <= time.monotonic() - at < 3:
                raise ValueError('无效按键时间或请求延迟超过缓冲区')
            if op == 'start':
                self.audio.begin(owner, at)
                return {}
            if op == 'stop':
                if self.audio.owner is not owner:
                    raise ValueError('录音不属于当前会话或已取消')
                deadline = time.monotonic() + 2
                while self.audio.chunks and self.audio.chunks[-1][1] < at:
                    if time.monotonic() > deadline:
                        self.audio.cancel(owner)
                        raise ValueError('等待录音尾部超时，未上传')
                    self.condition.wait(.05)
                    if self.audio.owner is not owner:
                        raise ValueError('录音已因设备异常取消')
                return {'wav': self.audio.extract(owner, at)}
            raise ValueError('未知命令')

    def client(self, conn):
        owner = object()
        try:
            with conn, conn.makefile('rb') as reader:
                hello = False
                while True:
                    line = reader.readline(8193)
                    if not line or len(line) > 8192:
                        break
                    req = json.loads(line)
                    try:
                        if not hello and req.get('op') != 'hello':
                            raise ValueError('需要 hello')
                        result = self.request(owner, req)
                        hello = True
                        reply = {'id': req.get('id'), 'result': result}
                    except Exception as error:
                        reply = {'id': req.get('id'), 'error': str(error)}
                    conn.sendall((json.dumps(reply) + '\n').encode())
        except (OSError, ValueError):
            pass
        finally:
            with self.condition:
                self.audio.cancel(owner)


def cleanup_modules():
    # Recover our own orphaned WebRTC module after a crash/restart, never others'.
    try:
        for line in pactl('list', 'short', 'modules').splitlines():
            if re.search(r'\bsource_name="?pi_mimo_daemon_\d+(?:"|\s|$)', line):
                pactl('unload-module', line.split()[0])
    except Exception:
        pass


def main():
    os.umask(0o077)
    runtime = os.environ.get('XDG_RUNTIME_DIR')
    if not runtime:
        raise RuntimeError('需要 Ubuntu 用户会话的 XDG_RUNTIME_DIR')
    directory = os.path.join(runtime, 'pi-mimo-voice')
    os.makedirs(directory, mode=0o700, exist_ok=True)
    with open(os.path.join(directory, 'lock'), 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = os.path.join(directory, 'capture.sock')
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        cleanup_modules()
        def terminate(*_):
            cleanup_modules()
            os._exit(0)
        signal.signal(signal.SIGTERM, terminate)
        signal.signal(signal.SIGINT, terminate)
        broker = Broker(configuration())
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(path)
            server.listen(16)
            server.settimeout(1)
            threading.Thread(target=broker.capture, daemon=True).start()
            while True:
                # A hung native read/connect cannot be safely interrupted from Python.
                # Fail the unit so systemd restarts it and reconnects clients cleanly.
                if time.monotonic() - broker.last > 10:
                    os._exit(1)
                try:
                    conn, _ = server.accept()
                except socket.timeout:
                    continue
                threading.Thread(target=broker.client, args=(conn,), daemon=True).start()


if __name__ == '__main__':
    main()
