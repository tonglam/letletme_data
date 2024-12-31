# Queue System Debug Guide - Active Issues

## Current Problem: Worker State Management

### Test Failures

1. "should start and stop worker"
2. "should handle worker restart with pending jobs"

Both failures occur at: `expect(E.isRight(startResult)).toBe(true);`

### Current Status

1. **State Transition Issues**

   - Worker emits 'ready' event too early (while in INITIAL state)
   - Worker doesn't emit second 'ready' event after `run()` is called
   - Timeout occurs while waiting for worker to transition to RUNNING state

2. **Attempted Fixes**

   - Added `hasReceivedReady` flag to track ready event state
   - Enhanced logging around state transitions
   - Modified worker configuration for better stability
   - Fixed state transition validation

3. **Remaining Issues**
   - Worker still times out waiting for ready event
   - State transitions not happening in expected order
   - Ready event timing issues persist

### Next Steps

1. **Worker Configuration Review**

   ```typescript
   // Current worker configuration
   const workerConfig = {
     autorun: false,
     lockDuration: isTest ? 10000 : 30000,
     concurrency: 1,
     maxStalledCount: 1,
     stalledInterval: isTest ? 10000 : 30000,
     drainDelay: 1,
     blockingConnection: false,
   };
   ```

   - [ ] Review BullMQ worker configuration options
   - [ ] Test with different connection settings
   - [ ] Verify Redis connection stability

2. **Event Handling Enhancement**

   ```typescript
   // Areas to improve
   worker.once('ready', onReady);
   worker.once('error', onError);
   worker.run();
   ```

   - [ ] Add connection event monitoring
   - [ ] Implement retry mechanism for worker start
   - [ ] Add more granular state checks

3. **Test Environment Setup**
   ```typescript
   // Test setup improvements needed
   beforeEach(async () => {
     // Ensure clean state
     // Verify Redis connection
     // Set up worker with proper config
   });
   ```
   - [ ] Add Redis connection checks
   - [ ] Improve cleanup between tests
   - [ ] Add more detailed error reporting

### Debug Data Collection

Latest test run shows:

1. Worker emits ready event in INITIAL state
2. State transition to STARTING happens after ready event
3. No second ready event received
4. Timeout after 15 seconds

### Progress

✅ Added enhanced logging
✅ Implemented state validation
✅ Added ready event tracking
❌ Fixed timing issues
❌ Resolved state transition problems

### Next Actions

1. **Connection Management**

   - Implement connection health checks
   - Add retry logic for worker start
   - Monitor Redis connection state

2. **State Synchronization**

   - Ensure state transitions match worker events
   - Add verification steps between transitions
   - Implement recovery mechanisms

3. **Test Improvements**
   - Add more granular test cases
   - Improve test isolation
   - Add connection verification

### Notes

- Focus on Redis connection stability
- Monitor event timing and order
- Consider implementing retry mechanism
- Review BullMQ documentation for worker lifecycle
