import os
import json
import re
import asyncio
from pathlib import Path
from fastapi import FastAPI, File, UploadFile, Form, Request
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from google import genai
from google.genai import types
from groq import Groq
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "db"
DB.mkdir(exist_ok=True)
load_dotenv(ROOT / ".env")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

mimo_client = OpenAI(
    api_key=os.getenv("MIMO_API_KEY"),
    base_url="https://api.xiaomimimo.com/v1",
)

gemini_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

groq_fixer_client = Groq(api_key=os.getenv("GROQ_API_KEY_3"))
groq_agent_client = Groq(api_key=os.getenv("GROQ_API_KEY_1"))
groq_user_client = Groq(api_key=os.getenv("GROQ_API_KEY_2"))

openai_agent_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

GROQ_MODEL = "llama-3.3-70b-versatile"
GROQ_USER_MODEL = "llama-3.1-8b-instant"

GROQ_AGENT_MODELS = {
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
}

def get_agent_client(model_id: str):
    if model_id in GROQ_AGENT_MODELS:
        return groq_agent_client
    return openai_agent_client


@app.get("/result")
def get_result():
    result_path = ROOT / "result.txt"
    if result_path.exists():
        with open(result_path, "r", encoding="utf-8") as f:
            return {"result": f.read()}
    return {"result": ""}


@app.get("/prompt")
def get_prompt():
    with open(ROOT / "campaign_prompt.txt", "r", encoding="utf-8") as f:
        return {"prompt": f.read()}


@app.post("/evaluate")
async def evaluate(transcript: UploadFile = File(...), prompt: str = Form(...)):
    raw = await transcript.read()
    if transcript.filename and transcript.filename.endswith(".txt"):
        transcript_str = raw.decode("utf-8")
    else:
        transcript_json = json.loads(raw)
        transcript_str = json.dumps(transcript_json, indent=2, ensure_ascii=False)

    print(f"\n=== INCOMING REQUEST ===")
    print(f"Transcript filename: {transcript.filename}")
    print(f"Transcript char count: {len(transcript_str)}")
    print(f"Prompt char count: {len(prompt)}")
    print(f"Transcript first 800 chars:\n{transcript_str[:800]}")
    print(f"=== END DIAGNOSTIC ===\n", flush=True)

    with open(ROOT / "evaluator.txt", "r", encoding="utf-8") as f:
        evaluator_prompt = f.read()

    filled = (
        evaluator_prompt
        .replace("{{SYSTEM_PROMPT}}", prompt)
        .replace("{{TRANSCRIPT}}", transcript_str)
    )

    print(f"Filled prompt total char count: {len(filled)}", flush=True)

    def stream():
        accumulated = []
        usage = {}
        response = mimo_client.chat.completions.create(
            model="mimo-v2.5",
            messages=[
                {"role": "system", "content": filled},
                {"role": "user", "content": "Evaluate the transcript against the system prompt and list all violations."},
            ],
            temperature=0.3,
            max_completion_tokens=16000,
            stream=True,
            stream_options={"include_usage": True},
            extra_body={"chat_template_kwargs": {"enable_thinking": False}},
        )
        for chunk in response:
            if chunk.usage:
                usage = {
                    "input_tokens": chunk.usage.prompt_tokens,
                    "output_tokens": chunk.usage.completion_tokens,
                }
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                accumulated.append(delta)
                yield delta
        raw_text = "".join(accumulated)
        with open(ROOT / "result.txt", "w", encoding="utf-8") as f:
            f.write(raw_text)

        parsed = None
        fence = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', raw_text)
        if fence:
            try:
                parsed = json.loads(fence.group(1))
            except Exception:
                pass
        if parsed is None:
            try:
                parsed = json.loads(raw_text.strip())
            except Exception:
                pass
        if parsed is None:
            obj = re.search(r'\{[\s\S]*\}', raw_text)
            if obj:
                try:
                    parsed = json.loads(obj.group(0))
                except Exception:
                    pass

        if parsed is not None:
            yield f"\n\n__RESULT__{json.dumps(parsed)}"
        if usage:
            usage["model"] = "mimo-v2.5"
            yield f"\n\n__USAGE__{json.dumps(usage)}"

    return StreamingResponse(stream(), media_type="text/plain")


@app.get("/fixer-prompt")
def get_fixer_prompt():
    with open(ROOT / "fixer_prompt.txt", "r", encoding="utf-8") as f:
        return {"prompt": f.read()}


@app.get("/user-prompt")
def get_user_prompt():
    with open(ROOT / "user_prompt.txt", "r", encoding="utf-8") as f:
        return {"prompt": f.read()}


@app.get("/runner-config")
def get_runner_config():
    with open(ROOT / "config.json", "r", encoding="utf-8") as f:
        return {"config": f.read()}


@app.post("/fix")
async def fix_prompt(old_prompt: str = Form(...), evaluation_results: str = Form(...)):
    with open(ROOT / "fixer_prompt.txt", "r", encoding="utf-8") as f:
        fixer_system = f.read()

    user_message = f"""EVALUATION_RESULTS:
{evaluation_results}

OLD_SYSTEM_PROMPT:
{old_prompt}"""

    print(f"\n=== FIX REQUEST ===")
    print(f"Old prompt chars: {len(old_prompt)}")
    print(f"Eval results chars: {len(evaluation_results)}")
    print(f"=== END ===\n", flush=True)

    def stream():
        accumulated = []
        usage = {}
        response = groq_fixer_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": fixer_system},
                {"role": "user", "content": user_message},
            ],
            temperature=0.3,
            stream=True,
            extra_body={"stream_options": {"include_usage": True}},
        )
        for chunk in response:
            if chunk.usage:
                usage = {
                    "input_tokens": chunk.usage.prompt_tokens,
                    "output_tokens": chunk.usage.completion_tokens,
                }
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta.content
            if delta:
                accumulated.append(delta)
                yield delta

        raw_text = "".join(accumulated)
        with open(ROOT / "fixed.txt", "w", encoding="utf-8") as f:
            f.write(raw_text)

        yield f"\n\n__RESULT__{json.dumps({'fixed_prompt': raw_text})}"
        if usage:
            usage["model"] = GROQ_MODEL
            yield f"\n\n__USAGE__{json.dumps(usage)}"

    return StreamingResponse(stream(), media_type="text/plain")


@app.post("/run-turn")
async def run_turn(
    agent_system_prompt: str = Form(...),
    messages_json: str = Form(...),
    agent_model: str = Form(default="llama-3.3-70b-versatile"),
    config_json: str = Form(default="{}"),
):
    try:
        config = json.loads(config_json)
        messages = json.loads(messages_json)
    except json.JSONDecodeError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})

    def safe_format(template, cfg):
        try:
            return template.format(**cfg)
        except (KeyError, IndexError, ValueError):
            out = template
            for k, v in cfg.items():
                out = out.replace("{" + k + "}", str(v))
            return out

    agent_system = safe_format(agent_system_prompt, config)
    selected_client = get_agent_client(agent_model)
    agent_messages = [{"role": "system", "content": agent_system}] + messages

    print(f"\n=== RUN TURN (manual) === model={agent_model} history_len={len(messages)}", flush=True)

    resp = await asyncio.to_thread(
        selected_client.chat.completions.create,
        model=agent_model,
        messages=agent_messages,
    )
    reply = resp.choices[0].message.content.strip()
    usage = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0, "model": agent_model}
    if resp.usage:
        cached = 0
        if hasattr(resp.usage, "prompt_tokens_details") and resp.usage.prompt_tokens_details:
            cached = resp.usage.prompt_tokens_details.cached_tokens or 0
        usage = {
            "input_tokens": resp.usage.prompt_tokens,
            "output_tokens": resp.usage.completion_tokens,
            "cached_tokens": cached,
            "model": agent_model,
        }
    return {"reply": reply, "usage": usage}


@app.post("/run")
async def run_conversation(
    request: Request,
    agent_system_prompt: str = Form(...),
    user_system_prompt: str = Form(...),
    config_json: str = Form(...),
    agent_model: str = Form(default="llama-3.3-70b-versatile"),
):
    try:
        config = json.loads(config_json)
    except json.JSONDecodeError as e:
        return {"error": f"Invalid config JSON: {e}"}

    def safe_format(template, cfg):
        try:
            return template.format(**cfg)
        except (KeyError, IndexError, ValueError):
            out = template
            for k, v in cfg.items():
                out = out.replace("{" + k + "}", str(v))
            return out

    agent_system = safe_format(agent_system_prompt, config)
    user_system = safe_format(user_system_prompt, config)

    MAX_TURNS = 50

    selected_agent_client = get_agent_client(agent_model)

    print(f"\n=== RUN REQUEST ===")
    print(f"Agent model: {agent_model}")
    print(f"Agent prompt chars: {len(agent_system)}")
    print(f"User prompt chars: {len(user_system)}")
    print(f"Max turns: {MAX_TURNS}")
    print(f"=== END ===\n", flush=True)

    async def stream():
        agent_history = []
        user_history = []
        messages = []
        agent_usage = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0}
        user_usage = {"input_tokens": 0, "output_tokens": 0, "cached_tokens": 0}

        for turn in range(1, MAX_TURNS + 1):
            if await request.is_disconnected():
                print(f"Client disconnected at turn {turn}", flush=True)
                break

            agent_messages = [{"role": "system", "content": agent_system}] + agent_history
            agent_resp = await asyncio.to_thread(
                selected_agent_client.chat.completions.create,
                model=agent_model,
                messages=agent_messages,
            )
            agent_reply = agent_resp.choices[0].message.content.strip()
            if agent_resp.usage:
                agent_usage["input_tokens"] += agent_resp.usage.prompt_tokens
                agent_usage["output_tokens"] += agent_resp.usage.completion_tokens
                cached = 0
                if hasattr(agent_resp.usage, "prompt_tokens_details") and agent_resp.usage.prompt_tokens_details:
                    cached = agent_resp.usage.prompt_tokens_details.cached_tokens or 0
                agent_usage["cached_tokens"] += cached
                print(f"  [Agent T{turn}] in={agent_resp.usage.prompt_tokens} cached={cached} out={agent_resp.usage.completion_tokens} | cumulative_out={agent_usage['output_tokens']}", flush=True)

            agent_history.append({"role": "assistant", "content": agent_reply})
            user_history.append({"role": "user", "content": agent_reply})
            messages.append({"turn": turn, "role": "agent", "content": agent_reply})

            yield f"__TURN__{json.dumps({'turn': turn, 'role': 'agent', 'content': agent_reply})}\n"

            agent_only_usage = {
                "input_tokens": agent_usage["input_tokens"] + user_usage["input_tokens"],
                "output_tokens": agent_usage["output_tokens"] + user_usage["output_tokens"],
                "agent_model": agent_model,
                "agent_input": agent_usage["input_tokens"],
                "agent_output": agent_usage["output_tokens"],
                "agent_cached": agent_usage["cached_tokens"],
                "user_model": GROQ_USER_MODEL,
                "user_input": user_usage["input_tokens"],
                "user_output": user_usage["output_tokens"],
                "user_cached": user_usage["cached_tokens"],
            }
            yield f"__USAGE__{json.dumps(agent_only_usage)}\n"

            if "end_call" in agent_reply.lower():
                print(f"end_call detected at turn {turn}", flush=True)
                break

            if await request.is_disconnected():
                print(f"Client disconnected after agent turn {turn}", flush=True)
                break

            user_messages = [{"role": "system", "content": user_system}] + user_history
            user_resp = await asyncio.to_thread(
                groq_user_client.chat.completions.create,
                model=GROQ_USER_MODEL,
                messages=user_messages,
            )
            user_reply = user_resp.choices[0].message.content.strip()
            if user_resp.usage:
                user_usage["input_tokens"] += user_resp.usage.prompt_tokens
                user_usage["output_tokens"] += user_resp.usage.completion_tokens
                print(f"  [Cand  T{turn}] in={user_resp.usage.prompt_tokens} out={user_resp.usage.completion_tokens} | cumulative_out={user_usage['output_tokens']}", flush=True)

            user_history.append({"role": "assistant", "content": user_reply})
            agent_history.append({"role": "user", "content": user_reply})
            messages.append({"turn": turn, "role": "candidate", "content": user_reply})

            yield f"__TURN__{json.dumps({'turn': turn, 'role': 'candidate', 'content': user_reply})}\n"

            running_usage = {
                "input_tokens": agent_usage["input_tokens"] + user_usage["input_tokens"],
                "output_tokens": agent_usage["output_tokens"] + user_usage["output_tokens"],
                "agent_model": agent_model,
                "agent_input": agent_usage["input_tokens"],
                "agent_output": agent_usage["output_tokens"],
                "agent_cached": agent_usage["cached_tokens"],
                "user_model": GROQ_USER_MODEL,
                "user_input": user_usage["input_tokens"],
                "user_output": user_usage["output_tokens"],
                "user_cached": user_usage["cached_tokens"],
            }
            yield f"__USAGE__{json.dumps(running_usage)}\n"

        transcript = {"messages": messages, "config": config}
        with open(ROOT / "run_transcript.json", "w", encoding="utf-8") as f:
            json.dump(transcript, f, indent=2, ensure_ascii=False)

        yield f"__TRANSCRIPT__{json.dumps(transcript)}\n"
        run_usage = {
            "input_tokens": agent_usage["input_tokens"] + user_usage["input_tokens"],
            "output_tokens": agent_usage["output_tokens"] + user_usage["output_tokens"],
            "agent_model": agent_model,
            "agent_input": agent_usage["input_tokens"],
            "agent_output": agent_usage["output_tokens"],
            "agent_cached": agent_usage["cached_tokens"],
            "user_model": GROQ_USER_MODEL,
            "user_input": user_usage["input_tokens"],
            "user_output": user_usage["output_tokens"],
            "user_cached": user_usage["cached_tokens"],
        }
        yield f"__USAGE__{json.dumps(run_usage)}\n"

    return StreamingResponse(stream(), media_type="text/plain")


@app.post("/evaluate-gemini")
async def evaluate_gemini(transcript: UploadFile = File(...), prompt: str = Form(...)):
    raw = await transcript.read()
    if transcript.filename and transcript.filename.endswith(".txt"):
        transcript_str = raw.decode("utf-8")
    else:
        transcript_json = json.loads(raw)
        transcript_str = json.dumps(transcript_json, indent=2, ensure_ascii=False)

    with open(ROOT / "evaluator.txt", "r", encoding="utf-8") as f:
        evaluator_prompt = f.read()

    filled = (
        evaluator_prompt
        .replace("{{SYSTEM_PROMPT}}", prompt)
        .replace("{{TRANSCRIPT}}", transcript_str)
    )

    def stream():
        accumulated = []
        usage = {}
        config = types.GenerateContentConfig(
            temperature=0.3,
            max_output_tokens=16000,
            thinking_config=types.ThinkingConfig(thinking_budget=-1),
            system_instruction=filled,
        )
        contents = [
            types.Content(
                role="user",
                parts=[types.Part.from_text(text="Evaluate the transcript against the system prompt and list all violations.")]
            )
        ]
        for chunk in gemini_client.models.generate_content_stream(
            model="gemini-2.5-flash",
            contents=contents,
            config=config,
        ):
            if chunk.text:
                accumulated.append(chunk.text)
                yield chunk.text
            if chunk.usage_metadata:
                thinking = getattr(chunk.usage_metadata, "thoughts_token_count", 0) or 0
                candidates = chunk.usage_metadata.candidates_token_count or 0
                usage = {
                    "input_tokens": chunk.usage_metadata.prompt_token_count or 0,
                    "output_tokens": candidates + thinking,
                    "thinking_tokens": thinking,
                }
                print(f"  [Gemini] in={usage['input_tokens']} out={candidates} thinking={thinking} billed_out={usage['output_tokens']}", flush=True)

        raw_text = "".join(accumulated)
        with open(ROOT / "result.txt", "w", encoding="utf-8") as f:
            f.write(raw_text)

        parsed = None
        fence = re.search(r'```(?:json)?\s*(\{[\s\S]*?\})\s*```', raw_text)
        if fence:
            try:
                parsed = json.loads(fence.group(1))
            except Exception:
                pass
        if parsed is None:
            try:
                parsed = json.loads(raw_text.strip())
            except Exception:
                pass
        if parsed is None:
            obj = re.search(r'\{[\s\S]*\}', raw_text)
            if obj:
                try:
                    parsed = json.loads(obj.group(0))
                except Exception:
                    pass

        if parsed is not None:
            yield f"\n\n__RESULT__{json.dumps(parsed)}"
        if usage:
            usage["model"] = "gemini-2.5-flash"
            yield f"\n\n__USAGE__{json.dumps(usage)}"

    return StreamingResponse(stream(), media_type="text/plain")


def _next_index(prefix: str, ext: str) -> int:
    existing = [f.name for f in DB.iterdir() if f.name.startswith(prefix) and f.name.endswith(ext)]
    nums = []
    for name in existing:
        try:
            nums.append(int(name[len(prefix):-len(ext)]))
        except ValueError:
            pass
    return max(nums, default=0) + 1


@app.post("/db/mistakes")
async def db_save_mistakes(payload: str = Form(...)):
    idx = _next_index("mistakes", ".json")
    path = DB / f"mistakes{idx}.json"
    with open(path, "w", encoding="utf-8") as f:
        f.write(payload)
    return {"saved": path.name}


@app.post("/db/prompt")
async def db_save_prompt(payload: str = Form(...)):
    idx = _next_index("prompt", ".txt")
    path = DB / f"prompt{idx}.txt"
    with open(path, "w", encoding="utf-8") as f:
        f.write(payload)
    return {"saved": path.name}


@app.post("/db/transcript")
async def db_save_transcript(payload: str = Form(...)):
    idx = _next_index("transcript", ".json")
    path = DB / f"transcript{idx}.json"
    with open(path, "w", encoding="utf-8") as f:
        f.write(payload)
    return {"saved": path.name}


@app.get("/db/list")
def db_list():
    files = []
    for f in sorted(DB.iterdir()):
        if f.is_file():
            files.append({
                "name": f.name,
                "size": f.stat().st_size,
                "modified": f.stat().st_mtime,
            })
    return {"files": files}


@app.get("/db/file/{filename}")
def db_get_file(filename: str):
    path = DB / filename
    if not path.exists() or not path.is_file():
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=404, content={"error": "not found"})
    resolved = path.resolve()
    if not str(resolved).startswith(str(DB.resolve())):
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=400, content={"error": "invalid path"})
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    return {"name": filename, "content": content}
