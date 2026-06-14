# AI Prompt Contract

The LLM should replace only the mock generator inside `app/api/drafts/route.ts`.

## Prompt Input

Use this structured input:

```ts
{
  person: Person;
  relationship: Relationship;
  cultureRule: CultureRule;
  occasion: OccasionNode | null;
  recentDeliveries: Delivery[];
  currentDraft?: MessageDraft;
  userInstruction: string;
}
```

## Prompt Requirements

The model must:

- Treat the email as the primary artifact.
- Use relationship kind and occasion kind to choose tone.
- Apply culture greetings and taboos before writing.
- Avoid generic festival or birthday copy.
- Keep cards optional and secondary.
- Return structured `MessageDraft` JSON only.
- Keep paragraphs plain text with optional highlight substrings.

## Output Guardrails

Reject or regenerate if:

- Paragraphs contain HTML.
- Required culture taboos are violated.
- The draft suggests sending money, red packets, custodial funds, or financial transfers.
- The card dominates the email body.
- The tone does not match the relationship and occasion.

## MVP Provider Swap

The UI should not change when the LLM is added. Replace:

- `baseRecipe()`
- `applyInstruction()`

with:

- prompt assembly
- provider call
- response validation
- fallback error message

