# Usability study protocol (version 3)

This is the plan for measuring how usable SecureWallet is, with the questionnaire already built into the wallet. It is written so the study can be run in one or two sessions before the defence and its results added to the report.

## Aim

To find out whether people who use mobile money can complete everyday tasks in SecureWallet without help, and whether the fraud protections (the PIN challenge, the scam check, the cooling-off period) are understood rather than felt as obstacles.

## Instrument

The System Usability Scale (SUS) (Brooke, 1996): ten statements answered on a five-point scale from "Strongly disagree" to "Strongly agree", alternating positive and negative wording. It is short, free to use, and its scores can be compared with published results. The wallet's version is at `/survey.html`, with "SecureWallet" in place of "this system".

Scoring follows Brooke (1996). Each odd-numbered (positive) statement scores its answer minus 1; each even-numbered (negative) statement scores 5 minus its answer; the sum is multiplied by 2.5 to give a score from 0 to 100 (`susScore` in `src/controllers/surveyController.js`, tested by TC-63). The score is not a percentage. In Bangor, Kortum and Miller's (2008) analysis of more than 2,300 SUS surveys the mean score was about 70, so a score above 70 means better than the typical system they studied, and a score below 50 means a serious usability problem.

## Participants

Between 8 and 12 people who use M-Pesa or another mobile wallet at least weekly, for example classmates, family members and staff, including at least two who do not work in computing. Small samples are normal for this kind of study; SUS gives reasonably stable means from about a dozen responses, and each participant's observed difficulties matter more than the exact mean. Nobody is paid, and participation is voluntary.

## Consent and data

Before starting, each participant reads a short statement: what the study is for, that SecureWallet is a simulation in which no real money moves, that they can stop at any time, and that only their questionnaire answers and the facilitator's notes are kept, without their name. They use an account created for the session (for example `p01@study.securewallet`), never their own details. If the department requires ethics approval for studies with people, it should be obtained before the sessions.

## Set-up

The website runs in enforce mode (`RISK_MODE=enforce`) so the protections appear as they would for a real user. Each participant gets a fresh account with KES 5,000 deposited and a second account to send money to. The facilitator watches without helping, notes where the participant hesitates, makes a wrong choice or asks for help, and times each task.

## Tasks

1. Sign in and find your balance.
2. Send KES 200 to the second account by email.
3. Set a transaction PIN.
4. Send KES 3,000 to a new recipient. (The scam check asks what it is for. Choose "Family or friends".)
5. Send KES 1,500 to another new recipient, choosing "Someone called or messaged and asked me to pay". Read the warning, then cancel the payment during the cooling-off period.
6. Deposit KES 1,000 through M-Pesa (simulated).
7. Find last week's payments and open a receipt.
8. Report the payment in task 2 as "This wasn't me", then explain in your own words what happened to your account.
9. Switch the wallet to Swahili and back.
10. Complete the questionnaire at `/survey.html`.

## Measures

- The SUS score for each participant, and the mean and range; the console's **Usability** page summarises them.
- For each task: completed without help, completed with help, or not completed; and the time taken.
- Notes on every point of confusion, especially at tasks 4, 5 and 8, which test whether the protections are understood.
- Participants' comments (the questionnaire has a free-text box).

## Reporting

Report the number of participants, the mean SUS score with its range, the completion rate and median time for each task, and the three or four most common problems with what was changed in response. Do not claim the results generalise to all users: the sample is small and is not random.

## References

Bangor, A., Kortum, P. T., & Miller, J. T. (2008). An empirical evaluation of the System Usability Scale. *International Journal of Human-Computer Interaction, 24*(6), 574–594. https://doi.org/10.1080/10447310802205776

Brooke, J. (1996). SUS: A "quick and dirty" usability scale. In P. W. Jordan, B. Thomas, B. A. Weerdmeester, & I. L. McClelland (Eds.), *Usability evaluation in industry* (pp. 189–194). Taylor & Francis.
