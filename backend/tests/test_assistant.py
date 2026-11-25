"""Assistant safety logic (no LLM calls). Run with pytest."""
import pytest

from app import assistant, llm


def test_number_guard_rejects_invented_figures():
    source = '{"gain_inr_30d": 541462, "cost_inr": 216000, "water_l": 144000, "due": "2026-11-30", "confidence_pct": 68}'
    assert assistant.grounded("Clean by 30 Nov: gain ₹541,462 for ₹216,000 and 144,000 L of water (68 % confidence).", source)
    assert assistant.grounded("Gain about ₹5.41 lakh, 144 kL of water.", source)          # roundings of given numbers
    assert not assistant.grounded("This will raise output by 12 % next week.", source)      # 12 is invented


def test_rate_limit_per_minute():
    user = "test-user-rate"
    for _ in range(assistant.RATE_PER_MINUTE):
        assistant.check_rate(user)
    with pytest.raises(llm.LLMError):
        assistant.check_rate(user)


def test_messages_are_trimmed_and_must_end_with_a_question():
    msgs = [{"role": "assistant", "content": "Hi"}] + [{"role": "user", "content": "x" * 5000}]
    out = assistant._clean_messages(msgs)
    assert out[0]["role"] == "user" and len(out[0]["content"]) == assistant.MAX_MESSAGE_CHARS
    with pytest.raises(llm.LLMError):
        assistant._clean_messages([{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}])


def test_issue_draft_falls_back_without_llm(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "")
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    d = assistant.draft_issue([{"role": "user", "content": "Upload fails with a timestamp error"}])
    assert d["category"] == "other" and "Upload fails" in d["title"]
