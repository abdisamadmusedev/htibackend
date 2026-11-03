const router = require("express").Router();
const service = require("./internshipService");
const action = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (error) { res.status(error.status || 500).json({ message: error.message }); }
};
router.get("/", action(async (req, res) => res.json({ data: await service.list(req.user, req.query) })));
router.post("/", action(async (req, res) => res.status(201).json({ data: await service.create(req.user, req.body) })));
router.patch("/:id", action(async (req, res) => res.json({ data: await service.setActive(req.user, req.params.id, req.body.isActive) })));
module.exports = router;
