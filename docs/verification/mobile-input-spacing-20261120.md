# iPhone spacing, typography and ask_user verification

## Final typography correction — 1.107

- User clarified that message text, not the composer, should be enlarged modestly. Source `1e61eabd7a5006877d79c26cc497578edf567abd` sets user message and final answer to 15px, removes the composer enlargement, and reduces custom-answer input to 16px.
- Actions `44701473927` succeeded. IPA plist and device app listing independently confirmed 1.107; installed following explicit user approval. A transient device disconnect recovered without deleting app data.
- WDA reopened existing 中文问候与交流 and inspected `/tmp/haish107-typography.png`: user bubbles and final answer are modest-sized, answer smaller than 1.106, and compact no-tool spacing remains. `/tmp/haish107-composer.png` confirms original composer typography and functioning keyboard; no message submitted or model run triggered.
- Keyboard/ask_user logic unchanged from the 1.106 on-device verification below. 13 related tests passed for the final code.

## Earlier 1.106 verification

- Source: `5d6622066c9f8bb3789acfd10aab5a5e54b826cf`; Actions `44698298937` succeeded. IPA plist and independent device app listing confirmed 1.106. Sideloadly reported Done. 100% after explicit installation approval.
- 13 keyboard/layout tests passed, including inline-question viewport resizing, composer hiding and restoration on dismissal. `git diff --check` passed.
- WDA on iPhone iOS 17.5.1 opened existing 中文问候与交流. Compared the same greeting in user screenshot: empty agent metadata reserve removed, response starts closer to user timestamp; final answer increased from 14px to 16px. User bubble unchanged. Composer and custom response textarea increased to 17px.
- Existing ask_user was completed and read-only. User explicitly authorized one test request. Sent exactly one request asking for ask_user/custom input only, with no other work.
- WDA focused live custom response and entered `今天想测试手机输入，边看问题边输入这段文字。`. Actual screenshot shows full question and two lines of typed answer above Chinese keyboard, no composer overlay, no gold focus outline/shadow. Submit answers remained untouched; task intentionally remains awaiting user input with a test draft.
- Screenshots inspected: `/tmp/haish106-greeting.png`, `/tmp/haish106-test-draft.png`, `/tmp/haish106-wait-question.png`, `/tmp/haish106-question-typing.png`. Final keyboard dismissal screenshot: `/tmp/haish106-question-dismissed.png`.
- Scope: portrait iPhone and short custom prompt verified; very long multi-question forms, landscape and all IMEs not exhaustively tested.
