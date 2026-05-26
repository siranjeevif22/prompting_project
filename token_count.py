import tiktoken

# Read the file
with open("transcript_1779382398499.json", "r", encoding="utf-8") as f:
    text = f.read()

# Use tokenizer matching OpenAI GPT-4 / GPT-3.5 models
enc = tiktoken.encoding_for_model("gpt-4")

# Count tokens
tokens = enc.encode(text)

# print(f"Characters: {len(text)}")
print(f"Tokens: {len(tokens)}")