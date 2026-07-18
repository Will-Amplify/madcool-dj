import math
from typing import Tuple


def equal_power_gains(x: float) -> Tuple[float, float]:
    """x in [0,1]: 0 = full A, 1 = full B."""
    x = 0.0 if x < 0 else 1.0 if x > 1 else float(x)
    a = math.cos(x * math.pi / 2)
    b = math.sin(x * math.pi / 2)
    return a, b
