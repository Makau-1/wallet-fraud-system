# SecureWallet functional test results

Run: 2026-11-10 05:30:15 UTC against http://localhost:3000 (scoring service http://127.0.0.1:8000)

| ID | Req. | Test description | Expected result | Actual result | Status |
|---|---|---|---|---|---|
| TC-01 | FR-01 | Register a new user with valid details | User created, password stored as bcrypt hash, wallet created with balance 0 | HTTP 201; bcrypt hash stored: true; wallet balance: 0.00 | Pass |
| TC-02 | FR-01 | Register with an email already in use | Request rejected; no duplicate user | HTTP 409 "Email already registered"; users with this email: 1 | Pass |
| TC-03 | FR-02 | Log in with correct credentials | Session created; user details returned without hash | HTTP 200; session valid: true; hash in response: false | Pass |
| TC-04 | FR-02 | Log in with a wrong password | HTTP 401 with generic message | HTTP 401 "Invalid email or password"; same message for unknown email: true | Pass |
| TC-05 | NFR-01 | Call a wallet endpoint without a session | HTTP 401; no data returned | HTTP 401 "Authentication required" | Pass |
| TC-06 | FR-03 | Deposit a positive amount | Balance increases; transaction recorded | HTTP 200; balance 0.00 to 5000.00; transaction #11 recorded | Pass |
| TC-07 | FR-03 | Deposit zero, a negative or a non-numeric amount | Request rejected; balance unchanged | HTTP 400, 400, 400; balance unchanged: true | Pass |
| TC-08 | FR-04 | Withdraw more than the balance | HTTP 400; balance unchanged | HTTP 400 "Insufficient funds"; balance unchanged: true | Pass |
| TC-09 | FR-05 | Transfer between two users | Both balances update atomically; one transaction row | HTTP 200; sender 5000.00 to 4800.00; recipient 0.00 to 200.00; one row #12 | Pass |
| TC-10 | FR-05 | Transfer to a non-existent email | HTTP 404; no balance changes | HTTP 404 "Recipient not found"; balance unchanged: true | Pass |
| TC-11 | FR-06 | View transaction history | All transactions listed newest first, paginated | HTTP 200; 2 transactions; newest first: true; 1 per page gives 2 pages | Pass |
| TC-12 | FR-07 | Small transfer consistent with normal behaviour | Scored; no alert created | HTTP 200; scored; fraud score 0.211667; alerts: 0 | Pass |
| TC-13 | FR-07 | Transfer that drains the sender balance | Scored at or above the threshold; pending alert created | HTTP 200; fraud score 0.751667; alert #3 pending; transfer completed: true | Pass |
| TC-14 | FR-08 | Administrator confirms and dismisses alerts | Status set to confirmed_fraud or cleared with reviewer and time | Confirm HTTP 200, dismiss HTTP 200; #3 confirmed_fraud, #4 cleared; reviewer and time recorded: true; second review refused: HTTP 409 | Pass |
| TC-15 | NFR-02 | Non-administrator calls an admin endpoint | HTTP 403 | List HTTP 403; review HTTP 403 "Administrator access required" | Pass |
| TC-16 | NFR-03 | Transfer while the inference service is stopped | Transfer completes; marked unscored | Run separately: stop the scoring service, then node tests/run-tests.js --tc16 | Not run |
