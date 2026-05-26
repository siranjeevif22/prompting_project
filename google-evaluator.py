import os
import json
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

data = "Puspanjali Sarma_call_transcript"
evaluator_prompt = read_file("evaluator.txt")
interview_system_prompt = read_file("prompt.txt")
transcript = read_json(f"{data}.json")

filled_prompt = (
    evaluator_prompt
    .replace("{{SYSTEM_PROMPT}}", interview_system_prompt)
    .replace("{{TRANSCRIPT}}", transcript)
)

import vertexai
from vertexai.generative_models import GenerativeModel, GenerationConfig

project = os.getenv("GOOGLE_CLOUD_PROJECT", "our-hull-487806-f3")
vertexai.init(project=project, location="us-central1")

model = GenerativeModel(
    model_name="gemini-3-flash",
    system_instruction=filled_prompt,
)

response = model.generate_content(
    "Evaluate the transcript against the system prompt and list all violations.",
    generation_config=GenerationConfig(
        temperature=0.3,
        max_output_tokens=12000,
    ),
    stream=True,
)

result_chunks = []
for chunk in response:
    text = chunk.text
    if text:
        print(text, end="", flush=True)
        result_chunks.append(text)

print()
result = "".join(result_chunks)

output_path = os.path.join(BASE_DIR, f"{data}.txt")
with open(output_path, "w", encoding="utf-8") as f:
    f.write(result)

print(f"\n--- Saved to {output_path} ---")
