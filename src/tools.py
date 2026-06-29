"""Tool registry and dispatch for Ornith OS.

Ornith-1.0 emits well-formed OpenAI-style ``tool_calls``; this module defines
the tools the model may call and executes them. Tools come in two flavours:

* **Local tools** are pure and self-contained (``get_time``, ``calculate``).
* **Orchestration tools** reach back into the runtime through callables the
  Agent Durable Object injects via ``ctx`` (``spawn_agent``, ``send_to_agent``,
  ``list_agents``). This keeps tools.py free of any Durable Object imports.

``dispatch()`` always returns a string — the tool result that gets appended to
the conversation as a ``role: "tool"`` message.
"""

import ast
import datetime
import json
import operator

# OpenAI-compatible tool definitions advertised to the model.
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
                    "expression": {
                        "type": "string",
                        "description": "The arithmetic expression to evaluate.",
                    }
                },
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "spawn_agent",
            "description": (
                "Spawn a new specialized sub-agent in the OS and give it a task. "
                "Returns the new agent's id."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Short name for the agent."},
                    "instructions": {
                        "type": "string",
                        "description": "The system instructions / role for the new agent.",
                    },
                    "task": {
                        "type": "string",
                        "description": "An optional first task to send to the agent.",
                    },
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


# --- Safe arithmetic evaluator -------------------------------------------------

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
        tree = ast.parse(str(expression), mode="eval")
        return str(_safe_eval(tree))
    except (ValueError, SyntaxError, TypeError, ZeroDivisionError) as exc:
        return f"error: {exc}"


# --- Dispatch ------------------------------------------------------------------


async def dispatch(name, arguments, ctx):
    """Execute tool ``name`` with ``arguments`` (a dict). Returns a string.

    ``ctx`` provides orchestration callables injected by the Agent DO:
    ``spawn_agent(name, instructions, task) -> str``,
    ``send_to_agent(agent_id, message) -> str``, and
    ``list_agents() -> list``.
    """
    args = arguments or {}

    if name == "get_time":
        return datetime.datetime.now(datetime.timezone.utc).isoformat()

    if name == "calculate":
        return _calculate(args.get("expression", ""))

    if name == "spawn_agent":
        spawn = ctx.get("spawn_agent")
        if not spawn:
            return "error: orchestration unavailable"
        return await spawn(
            args.get("name", "agent"),
            args.get("instructions", ""),
            args.get("task"),
        )

    if name == "send_to_agent":
        send = ctx.get("send_to_agent")
        if not send:
            return "error: orchestration unavailable"
        return await send(args.get("agent_id", ""), args.get("message", ""))

    if name == "list_agents":
        lister = ctx.get("list_agents")
        if not lister:
            return "error: orchestration unavailable"
        return json.dumps(await lister())

    return f"error: unknown tool '{name}'"
