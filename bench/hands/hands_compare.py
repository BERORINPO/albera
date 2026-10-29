"""Compare models as the "hands" of a host-driven Hyper-V desktop agent.

Standard library only. Each run: reset the task in the guest, let the model drive the
desktop through computer_toolset_20260801, then verify the result inside the guest via
PowerShell Direct. Spend is tracked per call and stops at a hard USD cap.

Usage: python hands_compare.py --models haiku sonnet --tasks t1 t2 t3 --trials 2 --cap-usd 5
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
VM = "albera-poc-01"
API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
MAX_STEPS = 40
SETTLE_SECONDS = 0.6

MODELS = {
    "haiku": {"id": "claude-haiku-5-5", "in": 0.10, "out": 0.50},
    "sonnet": {"id": "claude-sonnet-5-5", "in": 2.00, "out": 10.00},
    "opus": {"id": "claude-opus-5-5", "in": 4.00, "out": 20.00},
}
PRICE_BY_ID = {m["id"]: m for m in MODELS.values()}
# "hands+brain": the executor drives the desktop, the advisor is consulted for planning.
CONFIGS = {
    "haiku": ("haiku", None),
    "sonnet": ("sonnet", None),
    "opus": ("opus", None),
    "haiku+opus": ("haiku", "opus"),
    "haiku+sonnet": ("haiku", "sonnet"),
}
ADVISOR_BETA = "advisor-tool-2026-03-01"
ADVISOR_HINT = (
    " You have an advisor tool backed by a stronger model: consult it once before you start to plan "
    "the steps, and again whenever an action did not have the expected effect."
)
CACHE_READ_RATIO = 0.1
CACHE_WRITE_RATIO = 1.25

TASKS = {
    "t1": "Open Notepad and type this exact text (without the quotation marks): \"ALBERA hands test 1\". "
          "Then save the file to the Desktop as t1.txt (full path C:\\Users\\Administrator\\Desktop\\t1.txt). "
          "Close Notepad when done.",
    "t2": "Using File Explorer, create a new folder on the Desktop named albera-t2.",
    "t3": "Using File Explorer, rename the file rename-me.txt on the Desktop to done.txt "
          "(keep the .txt extension; the result must be exactly done.txt).",
    "c1": "On the Desktop, create a folder named proj containing two subfolders named src and docs. "
          "Then move the file readme-draft.txt from the Desktop into proj\\docs and rename it to readme.txt "
          "(the final file must be exactly readme.txt, not readme.txt.txt). Use File Explorer.",
    "c2": "Open the file form.html on the Desktop in Microsoft Edge. In the form, enter the name Velo, "
          "choose Plan B, and click Submit. The page then shows a confirmation code. Open Notepad, type only "
          "that code (for example ALB-1234), and save it to the Desktop as code.txt "
          "(full path C:\\Users\\Administrator\\Desktop\\code.txt). Close Notepad and Edge when done.",
    "c3": "The file inventory.txt on the Desktop lists 200 items, one per line, as name,quantity. Open it in Notepad "
          "and find (1) the quantity of item-137 and (2) the name of the item with the largest quantity. Then save "
          "a new file answer.txt on the Desktop containing exactly one line in this format: "
          "item-137=<quantity>;max=<item name> (for example item-137=12;max=item-005). Close Notepad when done.",
    "c4": "Change this computer's time zone to (UTC-08:00) Pacific Time (US & Canada) using the Settings app "
          "or Control Panel, and close the window when done.",
}
TASK_SCRIPT = {t: ("complex_tasks.ps1" if t.startswith("c") else "tasks.ps1") for t in TASKS}

SYSTEM = (
    "You operate a Windows Server 2025 desktop (1024x768) through the computer tools. "
    "Use only the graphical interface: do not open Command Prompt, PowerShell, Windows Terminal, "
    "or the Run dialog. The machine has no network access. After an action that changes the "
    "screen, take a screenshot before deciding the next step. When the task is complete, stop "
    "calling tools and reply with one line starting with DONE. If you cannot finish, reply with "
    "one line starting with FAILED and the reason."
)


def api_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise SystemExit("ANTHROPIC_API_KEY is not set")
    return key


def pwsh(script: str, *args: str) -> dict:
    cmd = ["pwsh", "-NoProfile", "-File", str(HERE / script), *args]
    no_window = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW: no console flashes
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180, creationflags=no_window)
    out = proc.stdout.strip().splitlines()
    if proc.returncode != 0 or not out:
        raise RuntimeError((proc.stderr or proc.stdout).strip()[-400:])
    return json.loads(out[-1])


def screenshot_b64(path: Path) -> str:
    pwsh("vm-act.ps1", "-Vm", VM, "-ActionJson", json.dumps({"name": "screenshot", "input": {}}),
         "-ShotPath", str(path))
    return base64.standard_b64encode(path.read_bytes()).decode("ascii")


def image_block(data: str) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": data}}


def call_api(key: str, body: dict, betas: list | None = None) -> dict:
    headers = {"x-api-key": key, "anthropic-version": API_VERSION, "content-type": "application/json"}
    if betas:
        headers["anthropic-beta"] = ",".join(betas)
    req = urllib.request.Request(API_URL, data=json.dumps(body).encode("utf-8"), method="POST", headers=headers)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:600]
            if e.code in (429, 500, 502, 503, 529) and attempt < 3:
                time.sleep(5 * (attempt + 1))
                continue
            raise RuntimeError(f"HTTP {e.code}: {detail}") from None
    raise RuntimeError("unreachable")


def cost_usd(model: dict, usage: dict) -> float:
    per = 1_000_000
    return (
        (usage.get("input_tokens") or 0) * model["in"] / per
        + (usage.get("cache_creation_input_tokens") or 0) * model["in"] * CACHE_WRITE_RATIO / per
        + (usage.get("cache_read_input_tokens") or 0) * model["in"] * CACHE_READ_RATIO / per
        + (usage.get("output_tokens") or 0) * model["out"] / per
    )


def call_cost(executor: dict, advisor: dict | None, usage: dict) -> tuple[float, float]:
    """(executor_usd, advisor_usd). Advisor iterations are priced at the advisor's rates."""
    iterations = usage.get("iterations") or []
    adv_iters = [it for it in iterations if "advisor" in str(it.get("type", ""))]
    adv = 0.0
    for it in adv_iters:
        price = PRICE_BY_ID.get(it.get("model")) or advisor or executor
        adv += cost_usd(price, it)
    exec_iters = [it for it in iterations if it not in adv_iters]
    if exec_iters:
        ex = sum(cost_usd(executor, it) for it in exec_iters)
    else:
        ex = cost_usd(executor, usage)
    return ex, adv


def run_actions(blocks: list, shot_dir: Path, step: int) -> list:
    """Execute tool_use blocks in order; stop at the first failure as the toolset requires."""
    results, failed = [], False
    for i, b in enumerate(blocks):
        res = {"type": "tool_result", "tool_use_id": b["id"]}
        if b.get("toolset_name"):  # only toolset members may carry toolset_name on their result
            res["toolset_name"] = b["toolset_name"]
        else:
            failed = True
            results.append({**res, "is_error": True, "content": f"Unknown tool: {b.get('name')}"})
            continue
        if failed:
            results.append({**res, "is_error": True,
                            "content": "Not executed: an earlier computer action in this turn failed."})
            continue
        try:
            if b["name"] == "screenshot":
                res["content"] = [image_block(screenshot_b64(shot_dir / f"s{step:02d}-{i}.png"))]
            else:
                out = pwsh("vm-act.ps1", "-Vm", VM, "-ActionJson", json.dumps({"name": b["name"], "input": b["input"]}))
                res["content"] = out["text"]
                time.sleep(SETTLE_SECONDS)
        except Exception as e:  # report the failure to the model instead of crashing the run
            failed = True
            res.update(is_error=True, content=f"Action failed: {e}")
        results.append(res)
    return results


def run_once(key: str, config: str, task: str, trial: int, budget: dict, cap: float) -> dict:
    exec_name, adv_name = CONFIGS[config]
    model, advisor = MODELS[exec_name], (MODELS[adv_name] if adv_name else None)
    script = TASK_SCRIPT[task]
    run_dir = HERE / "runs" / f"{config}-{task}-{trial}"
    run_dir.mkdir(parents=True, exist_ok=True)
    pwsh(script, "-Vm", VM, "-Task", task, "-Mode", "setup")
    time.sleep(1)
    first = screenshot_b64(run_dir / "s00-start.png")
    messages = [{"role": "user", "content": [image_block(first), {"type": "text", "text": TASKS[task]}]}]
    tools = [{"type": "computer_toolset_20260801", "configs": {"zoom": {"enabled": False}}}]
    betas, system = None, SYSTEM
    if advisor:
        tools.append({"type": "advisor_20260301", "name": "advisor", "model": advisor["id"],
                      "max_uses": 3, "caching": {"type": "ephemeral", "ttl": "5m"}})
        betas, system = [ADVISOR_BETA], SYSTEM + ADVISOR_HINT
    usage_sum = {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
    run_cost = adv_cost = 0.0
    actions, steps, advisor_calls, final, stop = 0, 0, 0, "", "max_steps"
    started = time.time()
    while steps < MAX_STEPS:
        if budget["spent"] >= cap:
            stop = "budget_cap"
            break
        steps += 1
        resp = call_api(key, {
            "model": model["id"], "max_tokens": 8192, "system": system, "tools": tools,
            "output_config": {"effort": "low"},
            "cache_control": {"type": "ephemeral"},
            "messages": messages,
        }, betas)
        u = resp.get("usage", {})
        if steps == 1:
            (run_dir / "usage-first-call.json").write_text(json.dumps(u, indent=1), encoding="utf-8")
        for k in usage_sum:
            usage_sum[k] += u.get(k, 0) or 0
        ex, adv = call_cost(model, advisor, u)
        run_cost += ex + adv
        adv_cost += adv
        budget["spent"] += ex + adv
        advisor_calls += sum(1 for b in resp["content"] if b.get("type") == "server_tool_use" and b.get("name") == "advisor")
        messages.append({"role": "assistant", "content": resp["content"]})
        tool_uses = [b for b in resp["content"] if b.get("type") == "tool_use"]
        if resp.get("stop_reason") == "refusal":
            stop = "refusal"
            break
        if resp.get("stop_reason") == "pause_turn" and not tool_uses:
            continue  # server tool paused mid-turn; resend so the model can resume
        if not tool_uses:
            final = " ".join(b.get("text", "") for b in resp["content"] if b.get("type") == "text").strip()
            stop = "end_turn"
            break
        actions += len(tool_uses)
        messages.append({"role": "user", "content": run_actions(tool_uses, run_dir, steps)})
    verdict = pwsh(script, "-Vm", VM, "-Task", task, "-Mode", "verify")
    record = {
        "model": config, "task": task, "trial": trial, "verified": verdict["ok"], "verify_detail": verdict["detail"],
        "claimed_done": final.upper().startswith("DONE"), "final": final[:200], "stop": stop,
        "api_calls": steps, "actions": actions, "advisor_calls": advisor_calls, "seconds": round(time.time() - started, 1),
        "cost_usd": round(run_cost, 4), "advisor_cost_usd": round(adv_cost, 4), **usage_sum,
    }
    (run_dir / "transcript.json").write_text(json.dumps(_strip_images(messages), ensure_ascii=False, indent=1), encoding="utf-8")
    return record


def _strip_images(messages: list) -> list:
    def strip(x):
        if isinstance(x, dict):
            if x.get("type") == "image":
                return {"type": "image", "omitted": True}
            return {k: strip(v) for k, v in x.items()}
        if isinstance(x, list):
            return [strip(v) for v in x]
        return x
    return strip(messages)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["haiku", "sonnet"], choices=sorted(CONFIGS))
    ap.add_argument("--log", default="results.jsonl")
    ap.add_argument("--tasks", nargs="+", default=list(TASKS), choices=sorted(TASKS))
    ap.add_argument("--trials", type=int, default=2)
    ap.add_argument("--cap-usd", type=float, default=5.0)
    args = ap.parse_args()
    key = api_key()
    budget = {"spent": 0.0}
    log = HERE / args.log
    for trial in range(1, args.trials + 1):
        for task in args.tasks:
            for m in args.models:
                if budget["spent"] >= args.cap_usd:
                    print(f"budget cap reached: ${budget['spent']:.4f}")
                    return
                try:
                    rec = run_once(key, m, task, trial, budget, args.cap_usd)
                except Exception as e:
                    rec = {"model": m, "task": task, "trial": trial, "verified": False, "stop": "error", "error": str(e)[:400]}
                rec["budget_spent_usd"] = round(budget["spent"], 4)
                with log.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                print(json.dumps(rec, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
