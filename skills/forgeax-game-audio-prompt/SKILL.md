---
name: forgeax-game-audio-prompt
description: Use when a ForgeaX player asks to generate or revise game BGM, sound effects, or voice, including natural-language requests submitted through the BGM & SFX Studio or an agent conversation.
---

# ForgeaX Game Audio Prompt

Convert player language into a compact, provider-ready game-audio prompt, then call the configured audio generation provider. Keep BGM, SFX, and VO rules separate behind one entry point.

## Workflow

1. Read the player request and any available game genre, scene, Sound Bible, reference audio, or project context.
2. Preserve every explicit player constraint. Use project context only to fill missing details; never override the current request.
3. Classify the output as `bgm`, `sfx`, or `voice`. Ask one question only when the kind is unknowable, VO lacks its script, or requirements directly conflict.
4. Build an internal brief, but send only the compact professional prompt defined in [the prompt contract](references/prompt-contract.md) to the provider.
5. Generate immediately after compilation. Do not pause for prompt approval unless the player explicitly asks to review it first. In an agent conversation, call `generate-audio-assets` — do not ask the player to click Generate in the audio studio. `/generate-game-audio` is this prompt skill, not a generation tool.
6. Retain the original request, compiled prompt, generation settings, provider, model, and trace ID with the generated versions.

The BGM & SFX Studio applies this compiler automatically before every provider request. Do not bypass it by sending raw player text directly to Lyria, ElevenLabs, or a TTS provider.

## Hard Rules

- Keep the complete VO script in the provider's text field and out of the performance-direction prompt. Never add, remove, translate, or paraphrase VO words.
- Keep the final prompt within the provider adapter's limit. Use defaults of 600 characters for BGM, 420 for SFX, and 320 for VO direction.
- Preserve, in order: audio identity, gameplay function, explicit constraints, loop behavior, critical exclusions, emotional direction, structure, and production detail.
- Remove generic recording language, secondary texture, secondary mood, and optional world-building detail first when over budget.
- Use no more than three meaningful exclusions. Avoid long boilerplate negative prompts.
- Replace requests to imitate a living artist or copy a known work with describable musical, sonic, or performance attributes.
- Fall back to the deterministic compact template when the text compiler is unavailable; never block a valid generation request solely because prompt enhancement failed.

## Completion Check

Confirm that the provider received the compiled prompt rather than raw UI text, the prompt fits its budget, VO text is unchanged, and generated metadata retains both the original and compiled forms.
