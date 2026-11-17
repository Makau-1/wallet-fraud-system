// Swahili for the wallet (version 3).
//
// The language is chosen with the SW/EN switch in the wallet's top bar and
// saved on the account (and in this browser for the sign-in pages). In
// Swahili, every piece of text on the page that has a translation below is
// replaced, including text the scripts add later, and the scripts' own
// messages go through t(). Text without a translation stays in English.
//
// The translations were written for this project and should be checked by
// a native speaker before real users see them. The administrator pages
// stay in English.

(function () {
    const SW = {
        // ---- navigation and top bar ----
        'Home': 'Nyumbani', 'Savings': 'Akiba', 'Loans': 'Mikopo', 'Requests': 'Maombi', 'Chamas': 'Chama',
        'Security': 'Usalama', 'Notifications': 'Arifa', 'Log out': 'Ondoka', 'My wallet': 'Pochi yangu',
        'Savings goals': 'Malengo ya akiba', 'Connecting': 'Inaunganisha', 'Live': 'Moja kwa moja', 'Reconnecting': 'Inaunganisha upya',
        'Wallet sections': 'Sehemu za pochi', 'Switch language': 'Badili lugha',
        // ---- balance and actions ----
        'Available balance': 'Salio linalopatikana', 'Loan owed': 'Mkopo unaodaiwa', 'Fraud monitoring': 'Ufuatiliaji wa ulaghai',
        'Fraud monitoring on': 'Ufuatiliaji wa ulaghai umewashwa', 'Scoring unavailable': 'Ukaguzi haupatikani',
        'Move money': 'Hamisha pesa', 'Send': 'Tuma', 'Request': 'Omba', 'Withdraw': 'Toa', 'Deposit': 'Weka',
        'To bank': 'Kwa benki', 'Pay bill': 'Lipa bili', 'Buy goods': 'Nunua bidhaa', 'Airtime': 'Muda wa maongezi', 'M-Pesa': 'M-Pesa',
        'Send money': 'Tuma pesa', 'Request money': 'Omba pesa', 'Withdraw cash': 'Toa pesa taslimu', 'Send to a bank': 'Tuma kwa benki',
        'Buy airtime': 'Nunua muda wa maongezi', 'Back to all actions': 'Rudi kwenye huduma zote',
        "Recipient's email": 'Barua pepe au nambari ya simu ya mpokeaji', 'Ask': 'Omba kutoka kwa', 'Recent recipients': 'Wapokeaji wa hivi karibuni',
        'Bank': 'Benki', 'Bank account number': 'Nambari ya akaunti ya benki', '6 to 16 digits': 'Tarakimu 6 hadi 16',
        'Business number': 'Nambari ya biashara', 'Till number': 'Nambari ya till', 'Phone number': 'Nambari ya simu',
        'Account number': 'Nambari ya akaunti', 'As shown on your bill': 'Kama ilivyo kwenye bili yako', 'Amount': 'Kiasi',
        'Note (optional)': 'Maelezo (si lazima)', "What it's for": 'Ni ya nini', 'Continue': 'Endelea',
        'Review before you confirm': 'Kagua kabla ya kuthibitisha', 'Edit': 'Hariri', 'Confirm': 'Thibitisha',
        'To': 'Kwa', 'Email': 'Barua pepe', 'Balance now': 'Salio sasa', 'Balance after': 'Salio baadaye', 'Share of balance': 'Sehemu ya salio',
        'You have paid this person before.': 'Umeshawahi kumlipa mtu huyu.',
        'You have not paid this person before. Check the name is who you expect.': 'Hujawahi kumlipa mtu huyu. Hakikisha jina ni la mtu unayemtarajia.',
        // ---- PIN step ----
        'One more check': 'Ukaguzi mmoja zaidi', 'Confirm with your PIN': 'Thibitisha kwa PIN yako',
        'This payment looks unusual for your account, so we need to know it is you. Nothing has been sent yet.': 'Malipo haya si ya kawaida kwa akaunti yako, kwa hivyo tunahitaji kujua ni wewe. Hakuna kilichotumwa bado.',
        'Transaction PIN': 'PIN ya malipo', 'Cancel payment': 'Ghairi malipo', 'Confirm payment': 'Thibitisha malipo',
        // ---- scam check ----
        'Before you send': 'Kabla ya kutuma', 'What is this payment for?': 'Malipo haya ni ya nini?',
        'What is this {amount} for?': '{amount} hii ni ya nini?',
        'You have not paid this person before. Scammers often tell people what to say, so answer honestly: nobody else sees this.': 'Hujawahi kumlipa mtu huyu. Matapeli mara nyingi huwaambia watu cha kusema, kwa hivyo jibu kwa ukweli: hakuna mtu mwingine atakayeona jibu hili.',
        'Family or friends': 'Familia au marafiki', 'Paying for goods or services': 'Malipo ya bidhaa au huduma',
        'Bills, rent or school fees': 'Bili, kodi ya nyumba au karo', 'Someone called or messaged and asked me to pay': 'Mtu alinipigia au kunitumia ujumbe akaniomba nilipe',
        'An investment or trading opportunity': 'Fursa ya uwekezaji au biashara', 'A fee to get a job, prize or loan': 'Ada ya kupata kazi, zawadi au mkopo',
        'Returning money someone says they sent me by mistake': 'Kurudisha pesa ambazo mtu anasema alinitumia kimakosa', 'Something else': 'Sababu nyingine',
        'Stop and check. This is how many scams start.': 'Simama uhakikishe. Hivi ndivyo utapeli mwingi huanza.',
        'You chose:': 'Umechagua:',
        'Safaricom, banks and SecureWallet never call or text asking you to send money.': 'Safaricom, benki na SecureWallet hawapigi simu wala kutuma ujumbe wakikuomba utume pesa.',
        'Real jobs, prizes and loans never charge a fee first.': 'Kazi, zawadi na mikopo halali hazitozi ada kwanza.',
        'If someone says they sent you money by mistake, check your balance yourself. Never "send it back" to a different number.': 'Mtu akisema alikutumia pesa kimakosa, angalia salio lako mwenyewe. Usizirudishe kamwe kwa nambari tofauti.',
        'Guaranteed profits are a sign of a scam.': 'Faida inayohakikishwa ni dalili ya utapeli.',
        'If you continue, the payment waits for a cooling-off period before it is sent, and you can cancel it from your activity until then.': 'Ukiendelea, malipo yatasubiri kipindi cha kutafakari kabla ya kutumwa, na unaweza kuyaghairi kwenye shughuli zako hadi wakati huo.',
        'Continue with cooling-off': 'Endelea na kipindi cha kutafakari', 'Cancel': 'Ghairi', 'Payment cancelled': 'Malipo yameghairiwa',
        'No money was sent': 'Hakuna pesa iliyotumwa', 'Cooling off': 'Kipindi cha kutafakari', 'Sending at {time}': 'Itatumwa saa {time}',
        'Payment will be sent at {time}': 'Malipo yatatumwa saa {time}', 'you can cancel it from your activity until then': 'unaweza kuyaghairi kwenye shughuli zako hadi wakati huo',
        '1 payment is cooling off. Open it in your activity to cancel it before it is sent.': 'Malipo 1 yako katika kipindi cha kutafakari. Yafungue kwenye shughuli zako ili uyaghairi kabla hayajatumwa.',
        '{n} payments are cooling off. Open them in your activity to cancel them before they are sent.': 'Malipo {n} yako katika kipindi cha kutafakari. Yafungue kwenye shughuli zako ili uyaghairi kabla hayajatumwa.',
        // ---- activity and receipts ----
        'Money requested from you': 'Pesa unazoombwa', 'All requests': 'Maombi yote', 'Activity': 'Shughuli',
        'Download statement': 'Pakua taarifa', 'Show older activity': 'Onyesha shughuli za zamani', 'Open receipt': 'Fungua risiti',
        'Check passed': 'Ukaguzi umepita', 'Under review': 'Inakaguliwa', 'On hold': 'Imesimamishwa', 'Not scored': 'Haijakaguliwa',
        'Verified with PIN': 'Imethibitishwa kwa PIN', 'Reviewed, cleared': 'Imekaguliwa, ni salama', 'Reviewed, released': 'Imekaguliwa, imetumwa',
        'Confirmed fraud': 'Ulaghai umethibitishwa', 'Stopped, refunded': 'Imesimamishwa, imerudishwa', 'Cancelled, refunded': 'Imeghairiwa, imerudishwa',
        'Transfer sent': 'Pesa zimetumwa', 'Transfer received': 'Pesa zimepokelewa', 'Withdrawal': 'Kutoa pesa', 'Bank transfer': 'Uhamisho wa benki',
        'Cash withdrawal': 'Kutoa pesa taslimu', 'Loan received': 'Mkopo umepokelewa', 'Loan repayment': 'Malipo ya mkopo', 'Loan': 'Mkopo',
        'Chama': 'Chama', 'Recovery': 'Urejeshaji', 'Money recovered for you': 'Pesa zimerejeshwa kwako',
        'SecureWallet receipt': 'Risiti ya SecureWallet', 'Date': 'Tarehe', 'Type': 'Aina', 'From': 'Kutoka', 'Status': 'Hali',
        'Completed': 'Imekamilika', 'Fraud check': 'Ukaguzi wa ulaghai', 'Purpose': 'Madhumuni', 'Balance before': 'Salio kabla',
        'Print': 'Chapisha', 'Close': 'Funga', 'Not applicable to this type': 'Haihusu aina hii',
        "This wasn't me": 'Si mimi niliyefanya hivi', 'Report this account': 'Ripoti akaunti hii', 'Cancel this payment': 'Ghairi malipo haya',
        'Freeze my account and report it': 'Funga akaunti yangu na uripoti', 'What happened? (optional)': 'Nini kilitokea? (si lazima)',
        'We will freeze your account straight away so no more money can leave it, return any payment that is still waiting, and an analyst will look into this one.': 'Tutafunga akaunti yako mara moja ili pesa zisitoke tena, tutarudisha malipo yoyote yanayosubiri, na mchambuzi atachunguza malipo haya.',
        'Reported. Your account is frozen.': 'Imeripotiwa. Akaunti yako imefungwa.', 'An analyst will review the payment': 'Mchambuzi atakagua malipo haya',
        'Send report': 'Tuma ripoti', 'Thank you. The account has been reported.': 'Asante. Akaunti imeripotiwa.',
        'Scam or fraud': 'Utapeli au ulaghai', 'Paid for goods or services that never came': 'Nililipia bidhaa au huduma ambazo hazikuja',
        'Pretended to be someone else': 'Alijifanya kuwa mtu mwingine', 'Took money without permission': 'Alichukua pesa bila ruhusa',
        'The money is back in your wallet': 'Pesa zimerudi kwenye pochi yako',
        // ---- savings, loans, requests ----
        'Locked savings': 'Akiba iliyofungwa', 'Total saved': 'Jumla ya akiba', 'New goal': 'Lengo jipya', 'Goal name': 'Jina la lengo',
        'For example, school fees': 'Kwa mfano, karo ya shule', 'Target amount (optional)': 'Kiasi kinacholengwa (si lazima)', 'Lock for': 'Funga kwa',
        'No lock (withdraw any time)': 'Bila kufunga (toa wakati wowote)', '7 days': 'Siku 7', '30 days': 'Siku 30', '3 months': 'Miezi 3',
        '6 months': 'Miezi 6', '1 year': 'Mwaka 1', 'Create goal': 'Unda lengo', 'Your goals': 'Malengo yako',
        'Instant loans': 'Mikopo ya papo hapo', 'You can borrow up to': 'Unaweza kukopa hadi', 'Borrow': 'Kopa', 'Borrow now': 'Kopa sasa',
        'Current loan': 'Mkopo wa sasa', 'Repayment amount': 'Kiasi cha kulipa', 'Amount to repay': 'Kiasi cha kulipa', 'Repay': 'Lipa', 'Pay all': 'Lipa yote',
        'Loan history': 'Historia ya mikopo', 'Money requests': 'Maombi ya pesa', 'New request': 'Ombi jipya', 'Send request': 'Tuma ombi',
        'Requested from you': 'Umeombwa', 'Your requests': 'Maombi yako',
        // ---- chamas ----
        'Group savings': 'Akiba ya kikundi', 'Your chamas': 'Chama zako', 'Start a chama': 'Anzisha chama', 'Name': 'Jina',
        'For example, Office Merry-Go-Round': 'Kwa mfano, Mchango wa ofisini', 'What it is for (optional)': 'Ni ya nini (si lazima)',
        'For example, December holiday': 'Kwa mfano, likizo ya Desemba', 'Goal amount (optional)': 'Kiasi cha lengo (si lazima)',
        'Usual contribution (optional)': 'Mchango wa kawaida (si lazima)', 'Start chama': 'Anzisha chama',
        'Choose a chama to see its members, contributions and payouts.': 'Chagua chama uone wanachama, michango na malipo yake.',
        'Save together with family, friends or colleagues. Everyone sees who has contributed what, and money leaves the pot only when most members approve.': 'Wekeni akiba pamoja na familia, marafiki au wenzenu kazini. Kila mtu anaona nani amechangia nini, na pesa hutoka kwenye mfuko tu wanachama wengi wakikubali.',
        'You are not in a chama yet. Start one, or ask a chair to invite you.': 'Bado hujajiunga na chama. Anzisha kimoja, au muombe mwenyekiti akualike.',
        'Join': 'Jiunge', 'Decline': 'Kataa', 'members': 'wanachama', 'to vote on': 'za kupigia kura', 'Your role': 'Nafasi yako',
        'chair': 'mwenyekiti', 'treasurer': 'mweka hazina', 'member': 'mwanachama', 'invited': 'amealikwa',
        'Member': 'Mwanachama', 'Role': 'Nafasi', 'Contributed': 'Amechangia', 'Received': 'Amepokea', 'Members': 'Wanachama',
        'Contribute': 'Changia', 'Contribute from your wallet': 'Changia kutoka kwenye pochi yako', 'Contribution amount': 'Kiasi cha mchango',
        'Payouts: {n} of {total} active members must approve': 'Malipo: wanachama {n} kati ya {total} lazima wakubali',
        'No payouts yet.': 'Bado hakuna malipo.', '{yes} of {needed} approvals': 'Idhini {yes} kati ya {needed}',
        'paid': 'imelipwa', 'rejected': 'imekataliwa', 'Approve': 'Kubali', 'Reject': 'Kataa',
        'Payout approved and paid': 'Malipo yamekubaliwa na kulipwa', 'Vote recorded': 'Kura imerekodiwa', 'Pay to': 'Lipa kwa', 'Reason': 'Sababu',
        'Propose payout': 'Pendekeza malipo', 'Propose a payout': 'Pendekeza malipo', 'Payout paid': 'Malipo yamelipwa', 'Payout proposed': 'Malipo yamependekezwa',
        'Waiting for other members to approve': 'Inasubiri wanachama wengine wakubali', 'Invite': 'Alika', 'Invite a member': 'Alika mwanachama',
        'Invitation sent.': 'Mwaliko umetumwa.', 'Email address to invite': 'Barua pepe ya kualika',
        'Join this chama from the list to take part.': 'Jiunge na chama hiki kwenye orodha ili ushiriki.',
        '{saved} of the {goal} goal': '{saved} kati ya lengo la {goal}', 'Contributed {amount}': 'Umechangia {amount}',
        // ---- security ----
        'Account protection': 'Ulinzi wa akaunti', 'Set your PIN': 'Weka PIN yako', 'Change your PIN': 'Badilisha PIN yako',
        'Account password': 'Nenosiri la akaunti', 'Current PIN': 'PIN ya sasa', 'New 4-digit PIN': 'PIN mpya ya tarakimu 4', 'Repeat the PIN': 'Rudia PIN',
        'Set PIN': 'Weka PIN', 'Change PIN': 'Badilisha PIN', 'PIN is set': 'PIN imewekwa', 'No PIN set': 'Hakuna PIN',
        'How payments are protected': 'Jinsi malipo yanavyolindwa', 'Low risk': 'Hatari ndogo', 'Unusual': 'Si ya kawaida', 'High risk': 'Hatari kubwa',
        'The payment is sent straight away.': 'Malipo yanatumwa mara moja.', 'You confirm with your PIN, then it is sent.': 'Unathibitisha kwa PIN yako, kisha yanatumwa.',
        'The money leaves your balance but is held. An analyst releases it or returns it to you.': 'Pesa zinatoka kwenye salio lako lakini zinasimamishwa. Mchambuzi anazituma au kuzirudisha kwako.',
        'Signed-in devices': 'Vifaa vilivyoingia', 'Sign out all other devices': 'Ondoa vifaa vingine vyote', 'this device': 'kifaa hiki', 'Last used': 'Kilitumika mwisho',
        'Signed out {n} other sessions.': 'Vipindi vingine {n} vimeondolewa.',
        'Two-factor sign-in': 'Kuingia kwa hatua mbili', 'Turn on': 'Washa', 'Turn off': 'Zima', 'On': 'Imewashwa', 'Off': 'Imezimwa',
        'Set up two-factor sign-in': 'Weka kuingia kwa hatua mbili', 'Code from the app': 'Msimbo kutoka kwenye programu',
        'Scan the code, or enter this key by hand:': 'Changanua msimbo, au andika ufunguo huu kwa mkono:',
        'Two-factor sign-in is on. You will need the app each time you sign in.': 'Kuingia kwa hatua mbili kumewashwa. Utahitaji programu kila unapoingia.',
        'Two-factor sign-in is off.': 'Kuingia kwa hatua mbili kumezimwa.',
        'Mobile number': 'Nambari ya simu', 'Kenyan mobile number': 'Nambari ya simu ya Kenya', 'Save number': 'Hifadhi nambari', 'Number saved.': 'Nambari imehifadhiwa.',
        'Not linked': 'Haijaunganishwa',
        'Lets people send you money by phone number, charges M-Pesa deposits to it, and lets you use SecureWallet by USSD on any phone.': 'Inawawezesha watu kukutumia pesa kwa nambari ya simu, inatumika kwa kuweka pesa kupitia M-Pesa, na inakuwezesha kutumia SecureWallet kwa USSD kwenye simu yoyote.',
        'Freeze my account': 'Funga akaunti yangu', 'Freeze my account now': 'Funga akaunti yangu sasa', 'Tap again to freeze': 'Gusa tena kufunga',
        'Your account is frozen': 'Akaunti yako imefungwa', 'Frozen. No money can leave your account.': 'Imefungwa. Hakuna pesa inayoweza kutoka kwenye akaunti yako.',
        'Lost your phone, or think someone knows your PIN? Freezing stops all money leaving your account and cancels payments that are waiting. Support restores it once you are safe.': 'Umepoteza simu, au unadhani mtu anajua PIN yako? Kufunga kunazuia pesa zote kutoka kwenye akaunti yako na kughairi malipo yanayosubiri. Huduma kwa wateja huirejesha ukiwa salama.',
        'Your data': 'Data yako', 'Download my data': 'Pakua data yangu', 'Helping us test?': 'Unatusaidia kujaribu?', 'Rate SecureWallet': 'Tathmini SecureWallet',
        'in a 10-question survey.': 'kwa dodoso la maswali 10.',
        'Download a copy of the personal data SecureWallet holds about you, as the Kenya Data Protection Act, 2019 allows.': 'Pakua nakala ya data binafsi ambayo SecureWallet inahifadhi kukuhusu, kama Sheria ya Ulinzi wa Data ya Kenya, 2019 inavyoruhusu.',
        'What is checked': 'Kinachokaguliwa',
        'You signed in on a new device. For the next 24 hours, unusual payments from it get extra checks.': 'Umeingia kwa kifaa kipya. Kwa saa 24 zijazo, malipo yasiyo ya kawaida kutoka kwake yatakaguliwa zaidi.',
        // ---- M-Pesa ----
        'Deposit with M-Pesa': 'Weka pesa kwa M-Pesa', 'Top up from M-Pesa': 'Ongeza salio kutoka M-Pesa',
        'We send a payment prompt to your phone. Enter your M-Pesa PIN there to finish.': 'Tutatuma ombi la malipo kwenye simu yako. Weka PIN yako ya M-Pesa hapo kumaliza.',
        'M-Pesa number': 'Nambari ya M-Pesa', 'Amount (whole shillings)': 'Kiasi (shilingi kamili)', 'Send prompt': 'Tuma ombi',
        'Simulated phone: no real M-Pesa account is charged.': 'Simu ya majaribio: hakuna akaunti halisi ya M-Pesa inayotozwa.',
        'Check your phone and enter your M-Pesa PIN.': 'Angalia simu yako na uweke PIN yako ya M-Pesa.', 'Not completed': 'Haijakamilika', 'Receipt': 'Risiti',
        'Simulator': 'Majaribio', 'Daraja sandbox': 'Daraja (majaribio)',
        // ---- notifications ----
        'Nothing yet. Money you receive and security alerts appear here.': 'Bado hakuna kitu. Pesa unazopokea na tahadhari za usalama zitaonekana hapa.',
        // ---- sign in and registration ----
        'Sign in': 'Ingia', 'Welcome back': 'Karibu tena', 'Email address': 'Barua pepe', 'Password': 'Nenosiri',
        'Use the email and password you registered with.': 'Tumia barua pepe na nenosiri ulilojisajili nalo.',
        'New to SecureWallet?': 'Mgeni kwenye SecureWallet?', 'Create an account': 'Fungua akaunti', 'Create account': 'Fungua akaunti',
        'Open your wallet': 'Fungua pochi yako', 'Full name': 'Jina kamili', 'At least 8 characters.': 'Angalau herufi 8.', 'Already registered?': 'Umeshajisajili?',
        'Enter the code from your authenticator app': 'Weka msimbo kutoka kwenye programu yako ya uthibitishaji', 'Verify': 'Thibitisha',
        'Signing in…': 'Inaingia…',
    };

    const STORE = 'sw_lang';
    let lang = 'en';
    try { lang = localStorage.getItem(STORE) === 'sw' ? 'sw' : 'en'; } catch (error) { lang = 'en'; }

    function fill(text, values) {
        return values ? text.replace(/\{(\w+)\}/g, (m, k) => (values[k] !== undefined ? values[k] : m)) : text;
    }

    function t(text, values) {
        if (lang === 'sw' && Object.prototype.hasOwnProperty.call(SW, text)) return fill(SW[text], values);
        return fill(text, values);
    }

    function translateNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            const raw = node.nodeValue;
            const key = raw.trim().replace(/\s+/g, ' ');
            // Only change text that differs, so the change does not trigger
            // the observer again.
            if (key && Object.prototype.hasOwnProperty.call(SW, key) && SW[key] !== key) {
                node.nodeValue = raw.replace(raw.trim(), SW[key]);
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE || node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
        ['placeholder', 'aria-label', 'title'].forEach(attr => {
            const value = node.getAttribute(attr);
            if (value && Object.prototype.hasOwnProperty.call(SW, value.trim()) && SW[value.trim()] !== value.trim()) {
                node.setAttribute(attr, SW[value.trim()]);
            }
        });
        node.childNodes.forEach(translateNode);
    }

    function start() {
        document.documentElement.lang = lang === 'sw' ? 'sw' : 'en';
        if (lang !== 'sw') return;
        translateNode(document.body);
        // Text the scripts add later is translated as it appears.
        new MutationObserver(mutations => mutations.forEach(m => {
            if (m.type === 'characterData') translateNode(m.target);
            m.addedNodes.forEach(translateNode);
        })).observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    window.SWi18n = {
        t,
        language: () => lang,
        set(next) {
            lang = next === 'sw' ? 'sw' : 'en';
            try { localStorage.setItem(STORE, lang); } catch (error) { /* this browser keeps no setting */ }
        },
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
