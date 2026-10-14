"""Every theme must be complete, and the four lists that name them must stay in step.

A theme in this app is a block of custom properties. Nothing enforces that a new one redefines
all of them: miss a token and the component reading it silently inherits the dark theme's value,
which shows up as one wrong-coloured surface on one tab rather than as anything that looks like
a bug. These checks make that a test failure instead.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / "web" / "assets" / "app.css").read_text(encoding="utf-8")
LOGIN = (ROOT / "web" / "login.html").read_text(encoding="utf-8")

THEMES = ["dark", "light", "vivid", "paper"]
# Set on :root rather than in a [data-theme] block: dark is the default, not an override.
SELECTOR = {t: ":root" if t == "dark" else f'[data-theme="{t}"]' for t in THEMES}


def _block(selector: str) -> str:
    """The body of the first rule with this exact selector, by brace matching."""
    start = CSS.index(selector + " {") + len(selector) + 1
    depth, i = 0, start
    while i < len(CSS):
        if CSS[i] == "{":
            depth += 1
        elif CSS[i] == "}":
            depth -= 1
            if depth == 0:
                return CSS[start + 1:i]
        i += 1
    raise AssertionError(f"unterminated rule for {selector}")


def _tokens(selector: str) -> set[str]:
    return set(re.findall(r"(--[a-z0-9-]+)\s*:", _block(selector)))


def test_every_theme_defines_every_palette_token():
    """No theme may fall through to another's palette for a token it forgot to set."""
    # :root also carries the tokens that are not palette at all -- spacing, type, radii -- and
    # those are deliberately shared. The palette is what each theme is obliged to restate, so
    # the baseline is what the two established overrides already agree on.
    required = _tokens(SELECTOR["light"]) & _tokens(SELECTOR["vivid"])
    assert len(required) > 40, f"only {len(required)} shared palette tokens found; parser drifted"
    for theme in THEMES:
        missing = required - _tokens(SELECTOR[theme])
        assert not missing, f"{theme} theme is missing {sorted(missing)}"


def test_theme_lists_agree_on_the_sign_in_page():
    """login.html cycles the toggle itself and validates a stored theme before first paint."""
    login_order = re.search(r"const THEMES = \[([^\]]+)\]", LOGIN).group(1)
    assert re.findall(r'"([a-z]+)"', login_order) == THEMES
    guard = re.search(r'\[([^\]]*"paper"[^\]]*)\]\.indexOf\(saved\)', LOGIN)
    assert guard, "login.html does not validate the stored theme against a list"
    assert sorted(re.findall(r'"([a-z]+)"', guard.group(1))) == sorted(THEMES)


def test_kindle_theme_is_flat_and_still_bounded_by_its_own_tokens():
    """The e-ink look is a claim about elevation and motion, so hold it to it."""
    paper = _block(SELECTOR["paper"])
    assert "--shadow-card: none;" in paper, "paper must not cast a card shadow"
    # Linear, because a decelerate implies momentum an e-ink panel does not have.
    assert re.search(r"--ease:\s*linear;", paper)
    # Every duration shorter than the fastest the lit themes use (150ms), so a state change
    # reads as a panel flip rather than a tween.
    for token in ("--quick", "--fast", "--med", "--slow"):
        value = int(re.search(rf"{token}:\s*(\d+)ms", paper).group(1))
        assert value <= 120, f"{token} is {value}ms; too slow to read as e-ink"
