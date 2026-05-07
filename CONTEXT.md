# Cross-Device Domain Context

## Terms

- **Cross-device Order**: A short-lived request started on one device and approved, rejected, cancelled, or finalized through the cross-device flow.
- **Challenge**: The canonical approval data and adapter-specific message that the approving device verifies before returning a proof.
- **Proof**: Adapter-verified evidence that authorizes approval of a cross-device Order.
- **Lifecycle**: The internal module that owns Cross-device Order workflow, including state transitions, proof verification, finalization, and event payload decisions.
- **Order Storage**: The internal module at the Better Auth adapter seam that hides model names, lookup shapes, and update persistence for Cross-device Orders.
- **Endpoint Catalog**: The internal module that names every Cross-device Order endpoint, method, operation id, and event name so server routes, clients, and tests share one catalog.
- **Cross-device Security**: The internal module that issues random token material, hashes and verifies tokens, rebuilds Challenge envelopes, and prepares Proof verification input.
- **HTTP Context**: The internal module that translates Better Auth request context into origins, trusted-origin decisions, finalized session cookies and token headers, and SSE frames.
- **Types Module**: The internal source module that owns shared public domain types so implementation modules do not import through the package barrel.
- **Test Harness**: The test support module that provides domain-level Cross-device Order flow helpers while leaving route-specific tests explicit.

## Source Layout

- `src/index.ts`: Public server plugin entrypoint.
- `src/client.ts`: Public client plugin entrypoint.
- `src/internal/order/`: Cross-device Order workflow, state, and Better Auth adapter storage.
- `src/internal/security/`: token material, Challenge construction, hashing, and Proof verification inputs.
- `src/internal/http/`: Better Auth route factories and HTTP context helpers.
- `src/internal/client/`: client-only internal response helpers.
- `src/internal/*.ts`: shared internal catalog, schema, error codes, and public domain types.
