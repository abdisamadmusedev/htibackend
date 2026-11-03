const service = require("../services/annualMarksService");
const handleError = (res, error) => res.status(error.status || (error.name === "SequelizeUniqueConstraintError" ? 409 : 500)).json({ message: error.message, ...(error.details || {}) });
exports.download = async (req, res) => {
  try {
    const workbook = await service.buildAnnualWorkbook(req.query, req.user);
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="both_terms_marks_template.xlsx"');
    res.status(200).send(Buffer.from(buffer));
  } catch (error) { handleError(res, error); }
};
const upload = confirm => async (req, res) => {
  try {
    if (!req.file?.buffer) throw Object.assign(new Error("Excel file is required in the file field"), { status: 400 });
    const inspections = await service.inspectAnnualWorkbook(req.file.buffer);
    if (!confirm) return res.json(service.annualPreview(inspections));
    const summary = await service.importAnnualWorkbook(inspections, req.file.originalname, req.user._id);
    res.status(201).json({ message: "Both terms imported successfully", summary });
  } catch (error) { handleError(res, error); }
};
exports.preview = upload(false);
exports.confirm = upload(true);
