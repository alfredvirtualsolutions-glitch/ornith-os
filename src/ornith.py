"""Ornith-1.0 model client for Ornith OS.

This module is the single place the agent runtime talks to a language model.
It speaks the OpenAI-compatible Chat Completions API that Ornith-1.0 exposes
when served with vLLM or SGLang, and transparently falls back to Cloudflare
Workers AI when no Ornith endpoint is configured (handy for local dev with no
GPU).

The public entry point is ``complete()``, which returns a normalized dict so
the rest of the OS never has to care which backend answered:

    {
      "content":    str,          # the final answer (no <think> block)
      "reasoning":  str,          # the chain-of-thought, if any
      "tool_calls": [ {...} ],    # normalized OpenAI-style tool calls
      "model":      str,
      "source":     "ornith" | "workers-ai",
    }

Ornith-1.0 is a reasoning model: assistant turns open with a ``<think>…</think>``
block. When served with ``--reasoning-parser qwen3`` the server returns that
trace in a separate ``reasoning_content`` field; we also defensively parse an
inline ``</think>`` marker for servers that don't split it.
"""

import json

from js import fetch as js_fetch, Object
from pyodide.ffi import to_js as _to_js_raw


def _to_js(obj):
    """Convert a Python object into a JS value, mapping dicts to JS objects."""
    return _to_js_raw(obj, dict_converter=Object.fromEntries)


def _get(env, name, default=None):
    """Read a Worker env var as a plain Python value, with a default."""
    value = getattr(env, name, None)
    if value is None:
        return default
    value = str(value)
    return value if value != "" else default


def _split_reasoning(content):
    """Split an inline ``<think>…</think>`` block out of a content string."""
    if content and "</think>" in content:
        reasoning, answer = content.split("</think>", 1)
        return reasoning.replace("<think>", "").strip(), answer.strip()
    return "", (content or "").strip()


def _normalize_tool_calls(raw_calls):
    """Normalize OpenAI-style tool_calls into plain dicts with parsed args."""
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


async def _complete_ornith(env, base_url, messages, tools, temperature, top_p, max_tokens):
    """Call an Ornith OpenAI-compatible /v1/chat/completions endpoint."""
    url = base_url.rstrip("/") + "/chat/completions"
    api_key = _get(env, "ORNITH_API_KEY", "EMPTY")
    model = _get(env, "ORNITH_MODEL", "Ornith-1.0")

    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": max_tokens,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    options = _to_js(
        {
            "method": "POST",
            "headers": {
                "content-type": "application/json",
                "authorization": f"Bearer {api_key}",
            },
            "body": json.dumps(payload),
        }
    )

    resp = await js_fetch(url, options)
    if not resp.ok:
        text = await resp.text()
        raise RuntimeError(f"Ornith endpoint returned {resp.status}: {text}")

    data = (await resp.json()).to_py()
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message", {}) or {}

    content = message.get("content") or ""
    reasoning = message.get("reasoning_content") or ""
    if not reasoning:
        reasoning, content = _split_reasoning(content)

    return {
        "content": content,
        "reasoning": reasoning,
        "tool_calls": _normalize_tool_calls(message.get("tool_calls")),
        "model": data.get("model", model),
        "source": "ornith",
    }


async def _complete_workers_ai(env, messages, tools, temperature, top_p, max_tokens):
    """Fall back to the Workers AI binding (no external endpoint required)."""
    model = _get(env, "ORNITH_FALLBACK_MODEL", "@cf/meta/llama-3.1-8b-instruct-fp8")

    inputs = {
        "messages": messages,
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": max_tokens,
    }
    if tools:
        inputs["tools"] = tools

    result = await env.AI.run(model, _to_js(inputs))
    # The binding returns a JsProxy; convert to a Python dict.
    try:
        data = result.to_py()
    except AttributeError:
        data = {"response": str(result)}

    content = data.get("response") or ""
    reasoning, content = _split_reasoning(content)

    return {
        "content": content,
        "reasoning": reasoning,
        "tool_calls": _normalize_tool_calls(data.get("tool_calls")),
        "model": model,
        "source": "workers-ai",
    }


async def complete(env, messages, tools=None):
    """Run one chat completion against Ornith (or the Workers AI fallback).

    ``messages`` is a list of OpenAI-style message dicts. ``tools`` is an
    optional list of OpenAI tool definitions. Returns the normalized dict
    documented at the top of this module.
    """
    temperature = float(_get(env, "ORNITH_TEMPERATURE", "0.6"))
    top_p = float(_get(env, "ORNITH_TOP_P", "0.95"))
    max_tokens = int(_get(env, "ORNITH_MAX_TOKENS", "2048"))

    base_url = _get(env, "ORNITH_BASE_URL")
    if base_url:
        return await _complete_ornith(
            env, base_url, messages, tools, temperature, top_p, max_tokens
        )
    return await _complete_workers_ai(
        env, messages, tools, temperature, top_p, max_tokens
    )
