const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = require("./src/app");
const connectDB = require("./src/config/db");

const PORT = process.env.PORT || 5001;

const start = async () => {
  await connectDB();
  require("./src/modules/attendance/internshipService").startWorker();
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
};

start();
