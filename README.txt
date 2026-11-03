TOSSKING v2 - free-play cricket toss prediction (virtual points only)

RUN
1. Install Node.js 20+
2. In this folder: npm install
3. npm start
4. Website: http://localhost:3000   Admin: http://localhost:3000/admin
(.env already has a JWT_SECRET and admin login. Change ADMIN_EMAIL / ADMIN_PASSWORD there anytime, then restart.)

HOW IT WORKS
- Users register/login, get 1000 free points, +100 daily bonus.
- Pick a team and back it with 10-500 points. Points are deducted immediately.
- Admin closes the match and sets the winner: winners share the whole pool in proportion to their points. If nobody picked the winner, or the match is voided, everyone is refunded.
- No deposits, payment gateway or cash-out - points have no monetary value.
