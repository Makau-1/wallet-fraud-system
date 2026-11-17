# SecureWallet load test

2026-11-17 06:29:07 UTC · 50 simultaneous users · 60 seconds · http://localhost:3000

Load generator machine: 2 CPU cores, 8 GB memory, Node v22.23.4. When the base URL is localhost, the website, the scoring service, the database and this script share those cores.

Requests: 4404 (73.4 a second). Responses: 2xx 4404.

| Request | Count | Median (ms) | 95th (ms) | 99th (ms) | Slowest (ms) |
|---|---|---|---|---|---|
| GET balance | 1468 | 484.1 | 1509.3 | 1628.3 | 1827.2 |
| GET history | 1468 | 95.6 | 419.9 | 1386.6 | 1587.4 |
| POST transfer | 1468 | 1271.2 | 2349.5 | 2528.1 | 2761.0 |

Each transfer includes the risk assessment (a call to the scoring model plus the behavioural, network and device checks), the double-entry journal entry and the audit record. The simulated users send far faster than any person would, so the velocity check challenges most of their transfers, and each challenged transfer also checks the PIN with bcrypt, which is slow on purpose. The figures are therefore a pessimistic ceiling for the transfer path. Users wait for each reply before sending the next request, so the rate shown is the most the system completed at that level of concurrency.
