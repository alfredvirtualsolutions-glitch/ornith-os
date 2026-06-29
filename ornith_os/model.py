"""Ornith-1.0 model client.

Talks to an Ornith-1.0 server over its OpenAI-compatible Chat Completions API
(as served by vLLM or SGLang). Configuration comes from environment variables:

* ``ORNITH_BASE_URL`` — the ``/v1`` base URL of the Ornith server.
* ``ORNITH_API_KEY``  — bearer token (any non-empty string for a local server).
* ``ORNITH_MODEL``    — served model name (default ``Ornith-1.0``).

Ornith-1.0 is a reasoning model: replies open with a ``<think>…</think>`` block.
Servers run with ``--reasoning-parser`` return it in ``reasoning_content``; we
also parse an inline ``</think>`` marker defensively. ``complete()`` returns a
normalized dict: ``{content, reasoning, tool_calls, model, source}``.
"""

import json
import os

import requests


def _env(name, default=None):
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def _split_reasoning(content):
    if content and "</think>" in content:
        reasoning, answer = content.split("</think>", 1)
        return reasoning.replace("<think>", "").strip(), answer.strip()
    return "", (content or "").strip()


def _normalize_tool_calls(raw_calls):
    calls = []
    for call in raw_calls or []:
        fn = call.get("function", {}) or {}
        args = fn.get("arguments", "{}")
        if isinstance(args, str):
            try:
                args = json.loads(args) if args.strip() else {}
            except (ValueError, TypeError):
                args = {"_raw": args}
        calls.append(
            {
                "id": call.get("id") or f"call_{len(calls)}",
                "name": fn.get("name", ""),
                "arguments": args,
            }
        )
    return calls


def complete(messages, tools=None):
    base_url = _env("ORNITH_BASE_URL")
    if not base_url:
        # Graceful degradation: no model endpoint configured yet.
        return {
            "content": (
                "Ornith OS is running, but no model endpoint is configured. "
                "Set ORNITH_BASE_URL and ORNITH_API_KEY to connect an Ornith-1.0 "
                "server (vLLM/SGLang)."
            ),
            "reasoning": "",
            "tool_calls": [],
            "model": "unconfigured",
            "source": "unconfigured",
        }

    payload = {
        "model": _env("ORNITH_MODEL", "Ornith-1.0"),
        "messages": messages,
        "temperature": float(_env("ORNITH_TEMPERATURE", "0.6")),
        "top_p": float(_env("ORNITH_TOP_P", "0.95")),
        "max_tokens": int(_env("ORNITH_MAX_TOKENS", "2048")),
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    resp = requests.post(
        base_url.rstrip("/") + "/chat/completions",
        json=payload,
        headers={"Authorization": f"Bearer {_env('ORNITH_API_KEY', 'EMPTY')}"},
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()

    message = (data.get("choices") or [{}])[0].get("message", {}) or {}
    content = message.get("content") or ""
    reasoning = message.get("reasoning_content") or ""
    if not reasoning:
        reasoning, content = _split_reasoning(content)

    return {
        "content": content,
        "reasoning": reasoning,
        "tool_calls": _normalize_tool_calls(message.get("tool_calls")),
        "model": data.get("model", payload["model"]),
        "source": "ornith",
    }
