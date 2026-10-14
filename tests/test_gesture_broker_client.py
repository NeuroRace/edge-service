import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "gesture_detector"))

from broker_client import StatusTicker, WebSocketBrokerClient, gesture_status_payload  # noqa: E402


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


class FakeSio:
    def __init__(self, fail=True):
        self.connected = False
        self.fail = fail
        self.connect_calls = []
        self.emitted = []

    def connect(self, url, **kwargs):
        self.connect_calls.append((url, kwargs))
        if self.fail:
            raise ConnectionError("broker fora")
        self.connected = True

    def emit(self, event, payload):
        self.emitted.append((event, payload))

    def disconnect(self):
        self.connected = False


class GestureBrokerClientTests(unittest.TestCase):
    def test_broker_down_never_raises_and_retries_at_most_every_2s(self):
        clock, sio = FakeClock(), FakeSio(fail=True)
        client = WebSocketBrokerClient("http://x:3000", 2, client_factory=lambda: sio, clock=clock)
        self.assertFalse(client.send_event("handGesture", {"player": 2}))
        clock.t = 1.0
        self.assertFalse(client.send_event("handGesture", {"player": 2}))
        self.assertEqual(len(sio.connect_calls), 1)
        clock.t = 2.5
        client.send_event("handGesture", {"player": 2})
        self.assertEqual(len(sio.connect_calls), 2)

    def test_connect_sends_auth_and_events_flow_once_connected(self):
        clock, sio = FakeClock(), FakeSio(fail=False)
        client = WebSocketBrokerClient("http://x:3000", 1, client_factory=lambda: sio, clock=clock)
        with client:
            self.assertTrue(client.send_event("gestureStatus", {"player": 1}))
        self.assertEqual(sio.connect_calls[0][1]["auth"], {"role": "gesture", "player": 1})
        self.assertEqual(sio.emitted, [("gestureStatus", {"player": 1})])

    def test_status_ticker_fires_immediately_then_every_interval(self):
        clock = FakeClock()
        ticker = StatusTicker(interval_s=2.0, clock=clock)
        self.assertTrue(ticker.due())
        clock.t = 1.9
        self.assertFalse(ticker.due())
        clock.t = 2.0
        self.assertTrue(ticker.due())

    def test_gesture_status_payload(self):
        self.assertEqual(gesture_status_payload(2, True, 123), {"player": 2, "handSeen": True, "timeStamp": 123})


if __name__ == "__main__":
    unittest.main()
