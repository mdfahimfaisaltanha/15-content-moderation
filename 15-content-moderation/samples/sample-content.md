# Sample content by expected pipeline path

Outcomes assume default thresholds (approve < 25, reject > 80) and the mock
classifier; exact scores may differ slightly with a real OpenAI key.

## → Approved by rules (Stage 2 skipped, zero flags)

- `Just adopted a rescue dog, any tips for the first week?`
- `The community meeting moved to Thursday 7pm at the hall.`
- `Made biryani from my grandmother's recipe and it actually worked.`

## → Rejected by rules (Stage 2 skipped, severe/decisive)

- `Nobody would miss you. Kill yourself.` *(severe term)*
- `Test card 4539 1488 0343 6467 exp 09/27, DM for more.` *(Luhn-valid card)*
- `CRYPTO GIVEAWAY!!! Double your money GUARANTEED. Act now, limited time offer — send gift cards or wire transfer to claim your prize!!!` *(3+ scam phrases)*
- `k1ll y0urself` *(leetspeak — normalization catches it)*

## → Dedupe fast-path

Submit any of the above twice — the second copy inherits the decision in ~1 ms.
The big scam line above is ALSO in the seed, so it may dedupe on your first try.

## → Stage 2 runs → approved (low final score)

- `Check out my ranking of this season's shows on my blog https://myblog.example/rankings — curious what you think!` *(one link + real text: mild)*

## → Stage 2 runs → pending review (the ambiguous middle)

- `Honestly whoever shipped this update is an idiot.` *(insult, not severe)*
- `Selling my old camera, DM me — mel.photos@example.com or 555-867-5309.` *(PII in public: judgment call)*
- `Some days I feel like there's no reason to live in this city anymore.` *(self-harm-adjacent phrasing — humans must look)*

## → Stage 2 runs → rejected (high classifier score)

- `Buy now! Click here for discount code deals, subscribe to my channel!!! https://a.example https://b.example https://c.example` *(link flood + spam keywords stack)*

## Things that should NOT trip the pipeline

- `My order number is 1234 5678 9012 3456, can someone from support help?`
  *(16 digits but fails Luhn → no card flag; may still hit the review band if
  other signals stack — that's working as intended)*
- `THIS IS SO EXCITING, WE WON THE LEAGUE!!!` *(caps alone = low flag, 10 pts → still approved)*
