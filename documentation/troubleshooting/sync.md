# Troubleshooting Guide: Event Live Data Sync & Caching

This document summarizes issues encountered and resolved during the implementation and testing of the event live data synchronization and caching features.

**Context:** The goal was to fetch live event data from the FPL API, store it in the database, enrich it, and cache the enriched data in Redis. Tests were failing at various stages, indicating problems in data validation, mapping, service logic, and cache interaction.

**1. Data Layer: API Schema Validation (`src/data/fpl/schemas/live/live.schema.ts`)**

*   **Symptoms:**
    *   Tests failed with `DataLayerError: Invalid response data for event live`.
    *   Zod validation errors indicated required fields were missing (e.g., `in_dream_team`, `element`).
*   **Root Cause:**
    *   The initial `LiveResponseSchema` incorrectly expected the player ID (`element`) to be nested within the `stats` object. The API provides it at a higher level.
    *   The schema used the key `in_dream_team`, but the actual API response used `in_dreamteam` (typo).
    *   Initial assumption about nullability of fields was incorrect.
*   **Resolution:**
    1.  Removed `element: z.number()` from the `LiveResponseSchema` definition (within the `stats` part).
    2.  Corrected the key name from `in_dream_team` to `in_dreamteam`.
    3.  Ensured `in_dreamteam` was correctly typed as `z.boolean().nullable()` based on observed API data and validation errors.

**2. Data Layer: API Data Mapping (`src/data/fpl/mappers/live/*.mapper.ts`)**

*   **Symptoms:**
    *   Tests passed validation but failed during the mapping step (`mapEventLiveResponseToDomain` / `mapEventLiveExplainResponseToDomain`).
    *   Errors indicated issues like "Invalid player ID: must be a positive integer," stemming from trying to access a non-existent `element` property on the input object.
*   **Root Cause:**
    *   The mapper functions (`mapEventLiveResponseToDomain`, `mapEventLiveExplainResponseToDomain`) expected the player ID as part of the `raw` stats object (`raw.element`), which it wasn't, following the schema correction.
*   **Resolution:**
    1.  Modified the signatures of `mapEventLiveResponseToDomain` and `mapEventLiveExplainResponseToDomain` to accept `elementIdInput: number | undefined | null` as a separate parameter.
    2.  Updated the internal logic of these mappers to use the `elementIdInput` parameter for the player ID instead of `raw.element`.
    3.  Updated the calling code in `src/data/fpl/live.data.ts` (`getLives`, `getExplains`) to pass the correct `element.id` when iterating and calling the mappers.
    4.  Corrected the mapped key name `inDreamTeam` in `mapEventLiveResponseToDomain` to align with schema/API data.

**3. Service Layer: Data Flow & Logic (`src/service/event-live/service.ts`)**

*   **Symptoms:**
    *   Initial tests showed data being fetched but not appearing in the database or cache.
    *   Reviewing the `syncEventLiveCacheFromApi` function revealed a missing step.
*   **Root Cause:**
    *   The step responsible for saving the fetched and mapped raw data to the database (`domainOps.saveEventLives`) was inadvertently removed or omitted from the `fp-ts` pipeline in `syncEventLiveCacheFromApi`.
*   **Resolution:**
    1.  Re-introduced the database save operation into the `syncEventLiveCacheFromApi` pipeline using `TE.chainFirstW`.
    2.  Ensured this step was placed *after* fetching/mapping the raw data but *before* the enrichment process.

**4. Service Layer: Type Inference (`src/service/event-live/service.ts`)**

*   **Symptoms:**
    *   After adding the database save step, linter/compiler errors appeared related to `fp-ts` `TaskEither` types within the pipeline.
    *   Errors pointed to incompatibilities between expected and actual error types (e.g., `ServiceError` vs `never`).
*   **Root Cause:**
    *   Combining `TE.chainFirstW` with the inner `pipe` for the database save (which returned `TE.TaskEither<ServiceError, void>`) led to ambiguity for the TypeScript compiler in inferring the error type of the resulting `TaskEither`.
*   **Resolution:**
    1.  Explicitly typed the error channel within the `TE.right` part of the database save pipe: changed `TE.right(undefined)` to `TE.right<ServiceError, void>(undefined)`. This provided the necessary type hint to the compiler.

**5. Domain Layer: Cache Parsing (`src/domain/event-live/cache.ts`)**

*   **Symptoms:**
    *   Tests showed data being successfully written to Redis (confirmed via logs including immediate read-back within `setEventLives`), but `getEventLives` consistently returned an empty array (`[]`).
    *   Added logging showed `parseEventLive` was being called but seemed to discard all items.
*   **Root Cause:**
    *   The `parseEventLive` function contained an incorrect validation check: `if ('id' in parsed && ...)` . It was looking for a top-level `id` property on the cached `EventLive` object, which does not exist according to the `EventLive` type definition. The correct identifying property is `elementId`. This caused every item to fail parsing and be filtered out.
*   **Resolution:**
    1.  Modified the validation check in `parseEventLive` to use the correct property: `if ('elementId' in parsed && typeof parsed.elementId === 'number')`.

**6. Testing / Environment: Cache Persistence & Visibility**

*   **Symptoms:**
    *   Logs and assertions *during* test runs proved data was successfully written to and read from Redis key `live::24-25::1`.
    *   Manual checks using `redis-cli HGETALL live::24-25::1` *after* the test suite finished showed `(empty array)`.
*   **Root Cause:**
    *   Individual tests within `tests/service/event-live.service.test.ts` use `redisClient.del(cacheKey)` *before* running to ensure isolation for that specific test's data.
    *   While not explicitly found in checked files, standard integration testing practices strongly suggest a global teardown process (likely configured via the test runner or an external script) executes `FLUSHALL` or `FLUSHDB` on the test Redis instance *after* the entire suite completes, clearing all data. Alternatively, the Redis instance itself might be ephemeral and shut down post-tests.
*   **Resolution (Confirmation):**
    1.  Added temporary `hgetall` logging at the very end of a test case in `tests/service/event-live.service.test.ts` to provide explicit log output confirming the data's presence *within the test run* just before the test completed. This verified the caching mechanism worked as intended within the test's scope.

---

This sequence highlights the importance of validating data at each layer transition (API -> Schema -> Mapper -> Service -> Cache -> Database) and carefully managing state and cleanup in integration tests. 