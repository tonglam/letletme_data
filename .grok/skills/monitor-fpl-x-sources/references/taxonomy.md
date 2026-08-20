# Receipt taxonomy

Receipts are source facts only. Use one conservative `evidenceRole` when the
editorial layer attaches them:

- `source`: the post or source page directly supports the claim.
- `context`: the source supplies background but does not establish the claim.
- `correction`: the source corrects an earlier source fact.

Do not infer a claim from an account identity, engagement count, or an
unverified screenshot. Every receipt must retain the supplied source ID,
external post ID, HTTPS canonical URL, capture time, and canonical hash.
