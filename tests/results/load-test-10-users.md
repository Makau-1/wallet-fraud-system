# SecureWallet load test

2026-11-17 06:27:50 UTC · 10 simultaneous users · 30 seconds · http://localhost:3000

Load generator machine: 2 CPU cores, 8 GB memory, Node v22.23.4. When the base URL is localhost, the website, the scoring service, the database and this script share those cores.

Requests: 1851 (61.7 a second). Responses: 2xx 1851.

| Request | Count | Median (ms) | 95th (ms) | 99th (ms) | Slowest (ms) |
|---|---|---|---|---|---|
| GET balance | 617 | 64.7 | 207.9 | 276.8 | 378.0 |
| GET history | 617 | 25.9 | 129.6 | 200.8 | 243.6 |
| POST transfer | 617 | 357.3 | 571.2 | 631.8 | 800.1 |

Each transfer includes the risk assessment (a call to the scoring model plus the behavioural, network and device checks), the double-entry journal entry and the audit record. The simulated users send far faster than any person would, so the velocity check challenges most of their transfers, and each challenged transfer also checks the PIN with bcrypt, which is slow on purpose. The figures are therefore a pessimistic ceiling for the transfer path. Users wait for each reply before sending the next request, so the rate shown is the most the system completed at that level of concurrency.
