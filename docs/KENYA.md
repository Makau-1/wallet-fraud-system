# Built for Kenya: M-Pesa, USSD, chamas and Swahili (version 3)

SecureWallet's fraud model is trained on PaySim, which simulates an African mobile money service. Version 3 makes the wallet itself work the way Kenyan mobile money is used: money arrives by M-Pesa, many users have feature phones, people save in groups, and not everyone reads English first. The wallet's currency is now the Kenya shilling (KES).

## M-Pesa deposits by STK push

The user chooses **M-Pesa** on the wallet, enters an amount and a Safaricom number, and a prompt appears on the phone asking for the M-Pesa PIN. When it is entered, Safaricom calls the wallet back and the money is credited from the journal account `external:mpesa`.

The integration (`src/services/mpesa.js`) follows Safaricom's Daraja STK push flow: an OAuth token from `oauth/v1/generate`, the request to `mpesa/stkpush/v1/processrequest` with the shortcode, a timestamp and the password `base64(shortcode + passkey + timestamp)`, and a result posted to the callback URL.

It runs in one of two modes, set by `MPESA_MODE`:

- **simulator** (the default). No Safaricom account is needed. The website draws the phone's prompt itself, and accepting or cancelling it sends a callback in the same shape Daraja sends (result code 0 for success, 1032 for cancelled by the user, 1037 for no answer). This is what the tests and the demonstration use.
- **sandbox**. Requests go to the real Daraja sandbox. It needs the consumer key and secret, shortcode and passkey from developer.safaricom.co.ke, and `PUBLIC_URL` set to the deployed site's HTTPS address so Safaricom can reach the callback.

Daraja does not sign its callbacks, so the callback address carries a long secret (`/api/mpesa/callback/<MPESA_CALLBACK_TOKEN>`). Sandbox mode refuses to start a payment unless that secret is at least 32 characters; without it the simulator uses a random one that changes on every restart, so there is no default anyone could guess. A callback is accepted only for a request that is still pending and only for the amount asked for, it is processed once (repeats are ignored), and in the simulator a request nobody answers is marked as timed out after two minutes. Test case TC-53 checks a payment, a cancellation, a repeated callback and a forged one.

The sandbox mode has been written against Safaricom's published API but could not be run end to end here, because it needs a Daraja account and a public HTTPS address. The simulator exercises the same callback handling.

## USSD for feature phones

A user with a basic phone dials a short code and gets a text menu (`src/services/ussd.js`), in the format Africa's Talking uses: each step arrives as a form post with the session, the phone number and every answer so far joined by `*`, and the reply starts with `CON` (more input) or `END` (the session closes).

```
Welcome to SecureWallet
1. Check balance
2. Send money
3. Mini statement
4. Lugha / Language
```

The user is identified by the phone number linked to their account under **Security**, and every action needs the transaction PIN. Sending money goes through the same payment service as the website, so the scam check, the risk engine, holds and cooling-off all apply, and the recipient's registered name is shown before the PIN is asked for, so a user can see they have the wrong number before any money moves. The menu is worked out from the answers alone, so no session state is kept between steps.

The live callback is `/api/ussd/callback/<USSD_CALLBACK_TOKEN>`. For demonstration, `USSD_SIMULATOR=1` switches on `/ussd.html`, a phone screen with a keypad that sends the same requests Africa's Talking would. The simulator works only for a signed-in user and always dials from that user's own linked number, so it cannot be used to look up other people's names or guess their PINs. Test case TC-54 covers this, the PIN, the balance, sending with the payee's name shown, and switching to Swahili.

## Chamas: group savings

A chama is a savings group with a shared pot (`src/controllers/chamaController.js`). The person who creates it is its chair and invites members by email. Members contribute from their wallets, and everyone in the group can see who has contributed what. Money leaves the pot only through a payout that a majority of active members approve (`floor(n / 2) + 1`, with the proposer counting as one), and only members who had already joined when the payout was proposed may vote on it, so no single member, the chair included, can empty the pot alone with the votes of people invited afterwards. A chair could still invite accounts they control before proposing a payout; members see who joins and are notified of every payout, but stopping this fully would need limits on invitations (for example, approval of new members by the group). The pot is its own journal account (`chama:<id>`) and is checked by every reconciliation. Test case TC-55 covers contributions and a two-member payout.

## Send to a phone number

Users can link a Kenyan number (in the format 07…, 01… or +254…) under **Security**; linking it needs the account password. Anyone can then pay them by entering that number instead of an email address, with the registered name shown before they confirm. Because the wallet is simulated, the number is not confirmed by SMS; a live deployment would send a one-time code to the number before linking it, so nobody can claim someone else's number. Test case TC-52 checks this.

## Swahili

The wallet, sign-in and registration pages switch between English and Swahili with the **SW / EN** button in the top bar (`src/public/i18n.js`), and the choice is remembered. The translation is a dictionary of about 300 interface phrases applied as the page changes; the USSD menu has its own English and Swahili text. The administrator console stays in English.

The Swahili text was written for this project and has not yet been reviewed by a native speaker; that review should happen before it is shown to users.
