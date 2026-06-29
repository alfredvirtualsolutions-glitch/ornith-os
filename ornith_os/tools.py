"""Tool registry and dispatch for Ornith OS.

Ornith-1.0 emits OpenAI-style ``tool_calls``; this module defines the tools and
executes them. Local tools (``get_time``, ``calculate``) are self-contained;
orchestration tools (``spawn_agent``, ``send_to_agent``, ``list_agents``) reach
back into the runtime through callables injected via ``ctx``.

``dispatch()`` always returns a string — the tool result appended to the
conversation as a ``role: "tool"`` message.
"""

import ast
import datetime
import json
import operator

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_time",
            "description": "Get the current UTC date and time (ISO 8601).",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "Evaluate a basic arithmetic expression, e.g. '2 * (3 + 4)'.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {"type": "string", "description": "The expression."}
                },
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spawn_agent",
            "description": "Spawn a new specialized sub-agent and optionally give it a task.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "instructions": {"type": "string"},
                    "task": {"type": "string"},
                },
                "required": ["name", "instructions"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "send_to_agent",
            "description": "Send a message to another agent by id and get its reply.",
            "parameters": {
                "type": "object",
                "properties": {
                    "agent_id": {"type": "string"},
                    "message": {"type": "string"},
                },
                "required": ["agent_id", "message"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_agents",
            "description": "List the agents currently registered in the OS.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]

_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}


def _safe_eval(node):
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPERATORS:
        return _OPERATORS[type(node.op)](_safe_eval(node.left), _safe_eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPERATORS:
        return _OPERATORS[type(node.op)](_safe_eval(node.operand))
    raise ValueError("unsupported expression")


def _calculate(expression):
    try:
        return str(_safe_eval(ast.parse(str(expression), mode="eval")))
    except (ValueError, SyntaxError, TypeError, ZeroDivisionError) as exc:
        return f"error: {exc}"


def dispatch(name, arguments, ctx):
    """Execute tool ``name`` with ``arguments`` (a dict). Returns a string."""
    args = arguments or {}

    if name == "get_time":
        return datetime.datetime.now(datetime.timezone.utc).isoformat()
    if name == "calculate":
        return _calculate(args.get("expression", ""))
    if name == "spawn_agent":
        spawn = ctx.get("spawn_agent")
        return spawn(args.get("name", "agent"), args.get("instructions", ""), args.get("task")) if spawn else "error: orchestration unavailable"
    if name == "send_to_agent":
        send = ctx.get("send_to_agent")
        return send(args.get("agent_id", ""), args.get("message", "")) if send else "error: orchestration unavailable"
    if name == "list_agents":
        lister = ctx.get("list_agents")
        return json.dumps(lister()) if lister else "error: orchestration unavailable"
    return f"error: unknown tool '{name}'"
