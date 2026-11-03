// Additive, repeatable migration. Never derives daily attendance from old records.
module.exports = async function migrateAttendance(sequelize) {
  const { DataTypes } = require("sequelize");
  const qi = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  for (const table of ["attendances", "dailyattendances"]) {
    if (!tables.includes(table)) continue;
    const status = (await qi.describeTable(table)).status;
    if (status && !String(status.type).includes("'InternshipVisit'")) {
      await qi.changeColumn(table, "status", {
        type: DataTypes.ENUM("Present", "Absent", "Late", "Permission", "Free", "InternshipVisit"),
        allowNull: status.allowNull,
        ...(status.defaultValue != null ? { defaultValue: status.defaultValue } : {}),
      });
    }
  }
  if (tables.includes("dailyattendances")) {
    const dailyColumns = await qi.describeTable("dailyattendances");
    if (!dailyColumns.revision) await qi.addColumn("dailyattendances", "revision", { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
  }
  if (!tables.includes("attendances")) return;
  const columns = await qi.describeTable("attendances");
  for (const [name, definition] of Object.entries({
    revision: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    teacherAssignmentId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    lessonId: { type: DataTypes.STRING, allowNull: false, defaultValue: "legacy" },
    contextKey: { type: DataTypes.STRING, allowNull: true },
  })) if (!columns[name]) await qi.addColumn("attendances", name, definition);
  // Unknown historical assignments remain unknown. Do not guess an author/period.
  await sequelize.query("UPDATE attendances SET contextKey = CONCAT('lesson:', studentId, ':', academicYearId, ':', COALESCE(termId,0), ':', classId, ':', DATE_FORMAT(attendanceDate, '%Y-%m-%d'), ':', attendanceSession, ':', COALESCE(subjectId,0), ':', lessonId) WHERE contextKey IS NULL");
  const [duplicates] = await sequelize.query("SELECT contextKey, COUNT(*) AS total FROM attendances GROUP BY contextKey HAVING COUNT(*) > 1 LIMIT 1");
  if (duplicates.length) throw new Error("Duplicate legacy lesson contexts require explicit administrator reconciliation before migration; no records were removed");
  const indexes = await qi.showIndex("attendances");
  if (!indexes.some(i => i.name === "contextKey" || i.unique && i.fields.length === 1 && i.fields[0].attribute === "contextKey")) await qi.addIndex("attendances", ["contextKey"], { unique: true, name: "uq_lesson_context" });
  if (indexes.some(i => i.name === "uq_attendance_entry")) await qi.removeIndex("attendances", "uq_attendance_entry");
};
