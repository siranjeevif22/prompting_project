import os
import json
from openai import OpenAI
from dotenv import load_dotenv
load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def read_file(filename):
    with open(os.path.join(BASE_DIR, filename), "r", encoding="utf-8") as f:
        return f.read()

def read_json(filename):
    with open(os.path.join(BASE_DIR, filename), "r", encoding="utf-8") as f:
        data = json.load(f)
    return json.dumps(data, indent=2, ensure_ascii=False)
data = "Soumya Swarup Das_call_transcript"
evaluator_prompt = read_file("evaluator.txt")
interview_system_prompt = read_file("prompt.txt")
transcript = read_json(f"{data}.json")

filled_prompt = evaluator_prompt.replace("{{SYSTEM_PROMPT}}", interview_system_prompt).replace("{{TRANSCRIPT}}", transcript)

client = OpenAI(
    api_key=os.getenv("MIMO_API_KEY"),
    base_url="https://api.xiaomimimo.com/v1",
)

response = client.chat.completions.create(
    model="mimo-v2.5",
    messages=[
        {"role": "system", "content": filled_prompt},
        {"role": "user", "content": "Evaluate the transcript against the system prompt and list all violations."},
    ],
    temperature=0.3,
    max_completion_tokens=8000,
    stream=True,
    stream_options={"include_usage": True},
    extra_body={"chat_template_kwargs": {"enable_thinking": False}},

)

result_chunks = []
usage = None
for chunk in response:
    if chunk.usage:
        usage = chunk.usage
    if not chunk.choices:
        continue
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
        result_chunks.append(delta)

print()
if usage:
    print(f"\n--- Tokens: input={usage.prompt_tokens} | output={usage.completion_tokens} | total={usage.total_tokens} ---")
result = "".join(result_chunks)

output_path = os.path.join(BASE_DIR, f"{data}.txt")
with open(output_path, "w", encoding="utf-8") as f:
    f.write(result)

print(f"\n--- Saved to {output_path} ---")
