"""Tests para módulo de caché TTL."""
import time
import pytest
from src.services import cache


@pytest.fixture(autouse=True)
def clear_cache():
    cache.clear()
    yield
    cache.clear()


def test_get_miss_on_empty():
    assert cache.get("key") is None


def test_set_and_get_hit():
    cache.set("k", [1, 2, 3], ttl_seconds=60)
    assert cache.get("k") == [1, 2, 3]


def test_get_miss_after_expiry():
    cache.set("k", "value", ttl_seconds=0.01)
    time.sleep(0.02)
    assert cache.get("k") is None


def test_invalidate_removes_entry():
    cache.set("k", "v", ttl_seconds=60)
    cache.invalidate("k")
    assert cache.get("k") is None


def test_invalidate_nonexistent_is_noop():
    cache.invalidate("nonexistent")


def test_clear_removes_all():
    cache.set("a", 1, ttl_seconds=60)
    cache.set("b", 2, ttl_seconds=60)
    cache.clear()
    assert cache.get("a") is None
    assert cache.get("b") is None


def test_overwrite_updates_value():
    cache.set("k", "old", ttl_seconds=60)
    cache.set("k", "new", ttl_seconds=60)
    assert cache.get("k") == "new"
