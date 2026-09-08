# Game Audio Prompt Contract

## Output

Compile one provider prompt from one player request. Return no explanation around it.

```json
{
  "kind": "bgm | sfx | voice",
  "originalRequest": "player text",
  "prompt": "compact provider-ready direction",
  "voiceText": "exact VO script only when kind is voice",
  "maxChars": 600,
  "source": "skill | fallback"
}
```

## BGM

Budget: 400–600 characters.

```text
{game type and gameplay use}; {style and world texture}; {primary mood and emotional movement}, {energy}; {tempo and rhythm}, featuring {core instruments}; {opening-to-development-to-climax arc}; {loop or ending}; {gameplay mix requirement}; avoid {two or three critical exclusions}.
```

## SFX

Budget: 280–420 characters.

```text
{game event and function}; {source} performs {action} against {material or target}; {force, scale and speed}; {distance and player perspective}; {onset}, {body}, {tail}; {space and style}; {duration or loop}; clean isolated game SFX with clear timing; avoid {two or three critical exclusions}.
```

## VO

Budget: 200–320 characters for direction. Pass the script separately and unchanged.

```text
{role, age impression and timbre}; {scene, listener and intent}; {emotion and movement}, {intensity}; {pace, pause and emphasis}; {language, accent or pronunciation}; {distance and recording texture}; natural game performance, clear diction; no added or changed words.
```

## Overflow Order

Delete lower-value material in this order: generic production phrases, secondary texture, secondary mood, optional world-building detail, then non-critical exclusions. Never delete the audio identity, gameplay use, player hard constraints, loop requirement, critical exclusion, or exact VO script.
