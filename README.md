This react-based site uses the API at https://github.com/gmitch215/TabroomAPI (credit to gmitch215) and basically just gives it a frontend. It will also hopefully include access to most of tabroom's services.
Additionally, there is a feature under development for efficiently dropping cases (using temporary generated access codes) in multiple formats. That's just my round vision for now.

Currently, this is only a work in progress, and doesn't have its own domain. That will change once the site meets its basic functionality goals.
If you would like to try using this app right now, I recommend cloning the repo and running 
npm run dev locally.

If you have any suggestions, comments, or advice, open up an issue. (The Tabroom history login still needs a production-hosted backend before deployment.)

The Tabroom history view signs in through the local Vite development server. Credentials are forwarded to Tabroom for authentication and are not retained; the server keeps the returned Tabroom session in memory and uses an HttpOnly browser session cookie. This integration is currently development-only: production hosting needs an equivalent server-side API and secure session store before the history feature can be deployed.