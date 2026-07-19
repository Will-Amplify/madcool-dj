import pytest

from madcool_dj_engine.mixer import equal_power_gains


def test_equal_power_endpoints():
    a, b = equal_power_gains(0.0)
    assert a == pytest.approx(1.0)
    assert b == pytest.approx(0.0)
    a, b = equal_power_gains(1.0)
    assert a == pytest.approx(0.0)
    assert b == pytest.approx(1.0)


def test_equal_power_mid_energy():
    a, b = equal_power_gains(0.5)
    assert (a * a + b * b) == pytest.approx(1.0, abs=1e-6)
