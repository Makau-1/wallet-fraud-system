# SecureWallet functional test results

Run: 2026-11-10 05:32:47 UTC against http://localhost:3000 (scoring service http://127.0.0.1:8000)

| ID | Req. | Test description | Expected result | Actual result | Status |
|---|---|---|---|---|---|
| TC-16 | NFR-03 | Transfer while the inference service is stopped | Transfer completes; marked unscored | HTTP 200; unscored; fraud score null; response in 98 ms | Pass |
