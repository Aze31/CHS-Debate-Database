This react-based site uses the API at https://github.com/gmitch215/TabroomAPI (credit to gmitch215) and basically just gives it a frontend. It will also hopefully include access to most of tabroom's services.
Additionally, there is a feature under development for efficiently dropping cases (using temporary generated access codes) in multiple formats. That's just my round vision for now.

Currently, this is only a work in progress, and doesn't have its own domain. That will change once the site meets its basic functionality goals.
If you would like to try using this app right now, I recommend cloning the repo and running 
npm run dev locally.

If you have any suggestions, comments, or advice, open up an issue.
<<<<<<< HEAD
=======

## NSDA member history (devs only)

The History page sends the entered member ID to the Vite server middleware, which requests the NSDA member, roles, points, honors, and point-category endpoints using HTTP Basic authentication. Credentials are read only on the server and are never sent to the browser.

When contacting NSDA, ask for an **API-specific Basic-auth username and password** and permission to read `GET /v2/members/{member_id}`, `GET /v2/members/{member_id}/roles`, `GET /v2/members/{member_id}/points`, `GET /v2/members/{member_id}/honors`, and `GET /v2/points/categories`. Ask NSDA which permission or scope is required for those reads; the API documentation confirms Basic authentication but does not specify credential provisioning or scopes. The app expects the username as `NSDA_API_USERNAME` and the password as `NSDA_API_PASSWORD`.

For local development, copy `.env.example` to `.env.local` in `CHS-Debate-Database/` and replace the placeholders with the credentials NSDA provides. Keep `.env.local` private and do not use a `VITE_` prefix for either variable. This middleware runs only in Vite development; production hosting needs an equivalent protected server-side API.
>>>>>>> refs/remotes/origin/main
