"""Opt-in controller; importing it does not start scans or modify engine behavior."""

from .loop import SelfImprovementLoop

__all__ = ["SelfImprovementLoop"]
