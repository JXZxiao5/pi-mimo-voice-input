import base64
import importlib.util
import io
import json
import math
import os
import socket
import struct
import threading
import time
import unittest
import wave
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('daemon', os.path.join(os.path.dirname(__file__), '../src/voice-daemon.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class BufferTests(unittest.TestCase):
    def test_exact_boundaries_no_preroll(self):
        audio = d.AudioBuffer()
        owner = object()
        pcm = struct.pack('<16000h', *range(16000))
        audio.append(11, pcm)
        audio.begin(owner, 10.25)
        data = base64.b64decode(audio.extract(owner, 10.75))
        with wave.open(io.BytesIO(data)) as wav:
            self.assertEqual(wav.getnframes(), 8000)
            self.assertEqual(wav.readframes(8000), pcm[8000:24000])
        self.assertIsNone(audio.owner)

    def test_chunks_and_bounded_idle_memory(self):
        audio = d.AudioBuffer()
        for i in range(1000):
            audio.append(i + 1, b'\0' * 32000)
        self.assertLessEqual(len(audio.chunks), 5)
        owner = object()
        audio.begin(owner, 999.5)
        audio.append(1001, b'\1' * 32000)
        data = base64.b64decode(audio.extract(owner, 1000.5))
        with wave.open(io.BytesIO(data)) as wav:
            self.assertEqual(wav.readframes(16000), b'\0' * 16000 + b'\1' * 16000)

    def test_ownership_cancel_and_expiry(self):
        audio = d.AudioBuffer()
        a, b = object(), object()
        audio.append(1, b'\0' * 32000)
        audio.begin(a, .5)
        with self.assertRaisesRegex(ValueError, '其他会话'):
            audio.begin(b, .5)
        audio.cancel(b)
        self.assertIs(audio.owner, a)
        with self.assertRaises(ValueError):
            audio.extract(b, .8)
        audio.cancel(a)
        audio.begin(b, .5)
        audio.append(190, b'\0' * 32000)
        self.assertIsNone(audio.owner)
        self.assertFalse(audio.chunks)


class BrokerTests(unittest.TestCase):
    def setUp(self):
        self.cfg = {'recordingDevice': '', 'recordingProcessing': 'none',
                    'recordingBackend': 'auto', 'recordingWarmupMs': 1000}
        self.broker = d.Broker(self.cfg)
        self.now = time.monotonic()
        self.broker.audio.append(self.now, b'\0' * 32000)
        self.broker.last = self.now
        self.broker.ready = True
        self.a, self.b = object(), object()

    def test_config_and_version_conflicts(self):
        for request in ({'protocol': 2, 'config': self.cfg}, {'protocol': 1, 'config': {}}):
            with self.assertRaisesRegex(ValueError, '不一致'):
                self.broker.request(self.a, {'op': 'hello', **request})
        result = self.broker.request(self.a, {'op': 'hello', 'protocol': 1, 'config': self.cfg})
        self.assertTrue(result['ready'])

    def test_busy_foreign_stop_and_stale_requests(self):
        self.broker.request(self.a, {'op': 'start', 'at': self.now - .5})
        for owner, req in [(self.b, {'op': 'start', 'at': self.now - .5}),
                           (self.b, {'op': 'stop', 'at': self.now})]:
            with self.assertRaises(ValueError):
                self.broker.request(owner, req)
        self.assertIs(self.broker.audio.owner, self.a)
        for at in (self.now - 4, self.now + 10, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                self.broker.request(self.a, {'op': 'stop', 'at': at})

    def test_stop_waits_for_audio_tail(self):
        self.broker.request(self.a, {'op': 'start', 'at': self.now - .5})
        stop = time.monotonic()
        def deliver():
            time.sleep(.05)
            with self.broker.condition:
                self.broker.audio.append(stop + .02, b'\1' * 640)
                self.broker.condition.notify_all()
        thread = threading.Thread(target=deliver)
        thread.start()
        result = self.broker.request(self.a, {'op': 'stop', 'at': stop})
        thread.join()
        self.assertIn('wav', result)
        self.assertIsNone(self.broker.audio.owner)

    def test_not_ready_does_not_start(self):
        self.broker.ready = False
        with self.assertRaises(ValueError):
            self.broker.request(self.a, {'op': 'start', 'at': self.now})
        self.assertIsNone(self.broker.audio.owner)

    def test_disconnect_cancels_owned_recording(self):
        client, server = socket.socketpair()
        thread = threading.Thread(target=self.broker.client, args=(server,))
        thread.start()
        reader = client.makefile('rb')
        for request in [{'op': 'hello', 'protocol': 1, 'config': self.cfg},
                        {'op': 'start', 'at': self.now - .5}]:
            client.sendall((json.dumps(request) + '\n').encode())
            self.assertNotIn('error', json.loads(reader.readline()))
        self.assertIsNotNone(self.broker.audio.owner)
        reader.close()
        client.close()
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertIsNone(self.broker.audio.owner)

    def test_old_ubuntu_pactl_and_monitor_rejection(self):
        def run(*args):
            if args == ('info',):
                return 'Default Source: mic\nDefault Sink: speaker'
            return 'Source #1\n Name: mic\n Mute: no\n'
        with patch.object(d, 'pactl', side_effect=run):
            self.assertEqual(d.source_for(self.cfg), ('mic', None))
        with patch.object(d, 'pactl', side_effect=lambda *a: run(*a) + '\n device.class = "monitor"'):
            with self.assertRaises(ValueError):
                d.source_for(self.cfg)


if __name__ == '__main__':
    unittest.main()
