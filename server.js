const cors = require("cors");

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "https://pos-frontend-git-main-sangeethas-projects-6e69f7d4.vercel.app"
    ],
    credentials: true
  })
);