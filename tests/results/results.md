# SecureWallet functional test results

Run: 2026-11-10 06:37:05 UTC against http://localhost:3000 (scoring service http://127.0.0.1:8000)

| ID | Req. | Test description | Expected result | Actual result | Status |
|---|---|---|---|---|---|
| TC-01 | FR-01 | Register a new user with valid details | User created, password stored as bcrypt hash, wallet created with balance 0 | HTTP 201; bcrypt hash stored: true; wallet balance: 0.00 | Pass |
| TC-02 | FR-01 | Register with an email already in use | Request rejected; no duplicate user | HTTP 409 "Email already registered"; users with this email: 1 | Pass |
| TC-03 | FR-02 | Log in with correct credentials | Session created; user details returned without hash | HTTP 200; session valid: true; hash in response: false | Pass |
| TC-04 | FR-02 | Log in with a wrong password | HTTP 401 with generic message | HTTP 401 "Invalid email or password"; same message for unknown email: true | Pass |
| TC-05 | NFR-01 | Call a wallet endpoint without a session | HTTP 401; no data returned | HTTP 401 "Authentication required" | Pass |
| TC-06 | FR-03 | Deposit a positive amount | Balance increases; transaction recorded | HTTP 200; balance 0.00 to 5000.00; transaction #28 recorded | Pass |
| TC-07 | FR-03 | Deposit zero, a negative or a non-numeric amount | Request rejected; balance unchanged | HTTP 400, 400, 400; balance unchanged: true | Pass |
| TC-08 | FR-04 | Withdraw more than the balance | HTTP 400; balance unchanged | HTTP 400 "Insufficient funds"; balance unchanged: true | Pass |
| TC-09 | FR-05 | Transfer between two users | Both balances update atomically; one transaction row | HTTP 200; sender 5000.00 to 4800.00; recipient 0.00 to 200.00; one row #29 | Pass |
| TC-10 | FR-05 | Transfer to a non-existent email | HTTP 404; no balance changes | HTTP 404 "Recipient not found"; balance unchanged: true | Pass |
| TC-11 | FR-06 | View transaction history | All transactions listed newest first, paginated | HTTP 200; 2 transactions; newest first: true; 1 per page gives 2 pages | Pass |
| TC-12 | FR-07 | Small transfer consistent with normal behaviour | Scored; no alert created | HTTP 200; scored; fraud score 0.211667; alerts: 0 | Pass |
| TC-13 | FR-07 | Transfer that drains the sender balance | Scored at or above the threshold; pending alert created | HTTP 200; fraud score 0.751667; alert #8 pending; transfer completed: true | Pass |
| TC-14 | FR-08 | Administrator confirms and dismisses alerts | Status set to confirmed_fraud or cleared with reviewer and time | Confirm HTTP 200, dismiss HTTP 200; #8 confirmed_fraud, #9 cleared; reviewer and time recorded: true; second review refused: HTTP 409 | Pass |
| TC-15 | NFR-02 | Non-administrator calls an admin endpoint | HTTP 403 | List HTTP 403; review HTTP 403 "Administrator access required" | Pass |
| TC-16 | NFR-03 | Transfer while the inference service is stopped | Transfer completes; marked unscored | Run separately: stop the scoring service, then node tests/run-tests.js --tc16 | Not run |
| TC-17 | FR-09 | Create a locked savings goal and move money into it | Goal created; wallet debited; goal balance credited; recorded as savings_deposit | Create HTTP 201; deposit HTTP 200; wallet 2000.00 to 1500.00; goal holds 500; recorded as savings_deposit | Pass |
| TC-18 | FR-09 | Withdraw from a goal before its unlock date | HTTP 409; wallet and goal unchanged | HTTP 409 "This goal is locked until 10 Dec 2026"; wallet unchanged: true; goal still holds 500 | Pass |
| TC-19 | FR-09 | Withdraw everything from a goal with no lock | Money returned to wallet; goal closed; recorded as savings_release | HTTP 200; wallet 1200.00 to 1500.00; goal closed; recorded as savings_release | Pass |
| TC-20 | FR-10 | Loan limit follows recent inflow | Limit is 30% of money received in the last 30 days, rounded down to 50 | HTTP 200; received 2,000.00; limit 600; eligible: true | Pass |
| TC-21 | FR-10 | Take a loan within the limit, then apply again | Wallet credited; amount due includes 7.5% fee; second application refused | HTTP 201; wallet 1500.00 to 1900.00; due 430 by 2026-12-10; second application HTTP 409 | Pass |
| TC-22 | FR-10 | Repay a loan in two parts | Overpayment refused; partial then final repayment clears the loan | Overpay HTTP 400; part HTTP 200 (230 left); final HTTP 200; loan repaid | Pass |
| TC-23 | FR-10 | Borrow after a transaction was confirmed as fraud | Loan refused with a fraud-related reason | Eligible: false; "Loans are unavailable because a recent transaction on this account was confirmed as fraud."; application HTTP 409 | Pass |
| TC-24 | FR-11 | Bank transfer, and one with an invalid account number | Valid transfer debits the wallet and is fraud-scored as a cash-out; invalid one rejected | Invalid HTTP 400; valid HTTP 200; wallet 1470.00 to 1220.00; scored, fraud score 0.485000 | Pass |
| TC-25 | FR-11 | Pay bill, buy goods and airtime | Each payment debits the wallet without a fraud score; invalid numbers rejected | Invalid HTTP 400; payments HTTP 200, 200, 200; wallet 1220.00 to 1050.00; no fraud check shown: true | Pass |
| TC-26 | FR-12 | Request money, pay it, and decline another | Request paid through a scored transfer; mismatched or reused transfer refused; decline recorded | Create HTTP 201; wrong amount HTTP 400; paid HTTP 200 (transfer scored); reused transfer HTTP 400; decline HTTP 200; statuses paid, declined | Pass |
