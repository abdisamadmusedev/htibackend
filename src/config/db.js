const { sequelize, initializeModels } = require("./mysql");

const addOptionalColumns = async () => {
  const queryInterface = sequelize.getQueryInterface();
  const { DataTypes } = require("sequelize");
  const tables = await queryInterface.showAllTables();
  const tableNames = new Set(
    tables.map((table) =>
      (typeof table === "string" ? table : table.tableName || table.name || "").toLowerCase()
    )
  );

  if (tableNames.has("departments")) {
    const departmentColumns = await queryInterface.describeTable("departments");
    if (!departmentColumns.defaultPassMark) {
      await queryInterface.addColumn("departments", "defaultPassMark", {
        type: DataTypes.DECIMAL(8, 2),
        allowNull: false,
        defaultValue: 50,
      });
    }
  }

  if (tableNames.has("temporaryannualbatchs")) {
    const batchColumns = await queryInterface.describeTable("temporaryannualbatchs");
    if (!batchColumns.passMark) {
      await queryInterface.addColumn("temporaryannualbatchs", "passMark", {
        type: DataTypes.DECIMAL(8, 2),
        allowNull: false,
        defaultValue: 50,
      });
    }
  }

  if (tableNames.has("students")) {
    const studentColumns = await queryInterface.describeTable("students");

    if (!studentColumns.classSectionId) {
      await queryInterface.addColumn("students", "classSectionId", {
        type: DataTypes.INTEGER.UNSIGNED,
        allowNull: true,
      });
    }
  }

  if (tableNames.has("users")) {
    const userColumns = await queryInterface.describeTable("users");
    if (userColumns.email && userColumns.email.allowNull === false) {
      await queryInterface.changeColumn("users", "email", {
        type: DataTypes.STRING,
        allowNull: true,
        unique: true,
      });
    }
    if (!userColumns.teacherId) {
      await queryInterface.addColumn("users", "teacherId", {
        type: DataTypes.INTEGER,
        allowNull: true,
        unique: true,
      });
    }
  }

  if (tableNames.has("attendances")) {
    const attendanceColumns = await queryInterface.describeTable("attendances");
    if (!attendanceColumns.subjectId) {
      await queryInterface.addColumn("attendances", "subjectId", {
        type: DataTypes.INTEGER,
        allowNull: true,
      });
    }

    const indexes = await queryInterface.showIndex("attendances");
    const attendanceIndex = indexes.find((index) => index.name === "uq_attendance_entry");
    const hasSubjectScope = attendanceIndex?.fields?.some((field) => field.attribute === "subjectId" || field.name === "subjectId");
    if (attendanceIndex && !hasSubjectScope) {
      await queryInterface.removeIndex("attendances", "uq_attendance_entry");
    }
    if (!hasSubjectScope) {
      await queryInterface.addIndex("attendances", ["studentId", "attendanceDate", "classId", "attendanceSession", "subjectId"], {
        name: "uq_attendance_entry",
        unique: true,
      });
    }
  }

  if (tableNames.has("attendances")) {
    await queryInterface.changeColumn("attendances", "status", {
      type: DataTypes.ENUM("Present", "Absent", "Late", "Permission", "Free", "InternshipVisit"),
      allowNull: false,
    });
  }

  if (tableNames.has("users")) {
    await queryInterface.changeColumn("users", "role", {
      type: DataTypes.ENUM(
        "SuperAdmin",
        "Director",
        "DeputyDirector",
        "StudentAffairs",
        "HeadDepartment",
        "AttendanceTaker",
        "Teacher",
        "ExamManager"
      ),
      allowNull: false,
    });
  }

  if (!tableNames.has("legacyresultstudents")) return;

  const legacyStudentColumns = await queryInterface.describeTable("legacyresultstudents");
  if (!legacyStudentColumns.admissionNo) {
    await queryInterface.addColumn("legacyresultstudents", "admissionNo", {
      type: DataTypes.STRING,
      allowNull: true,
    });
  }
  if (!legacyStudentColumns.legacyStudentKey) {
    await queryInterface.addColumn("legacyresultstudents", "legacyStudentKey", {
      type: DataTypes.STRING,
      allowNull: true,
    });
  }
  if (legacyStudentColumns.studentId && legacyStudentColumns.studentId.allowNull === false) {
    await queryInterface.changeColumn("legacyresultstudents", "studentId", {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    });
  }
};

module.exports = async function connectDB() {
  let stage = "initialize models";
  try {
    initializeModels();
    stage = "authenticate";
    await sequelize.authenticate();
    // Upgrade existing tables before sync creates indexes that use new columns.
    // On a fresh database this is a no-op; sync creates the complete schema.
    stage = "upgrade existing columns";
    await require("./assessmentMigration")(sequelize);
    await addOptionalColumns();
    await require("./attendanceMigration")(sequelize);
    stage = "sync schema";
    await sequelize.sync();
    stage = "upgrade columns after sync";
    await addOptionalColumns();
    // Older records predate academic-year scoping. When there is exactly one active
    // year, safely attach only unscoped classes and teachers to it.
    stage = "backfill academic years";
    const models = initializeModels();
    const activeYears = await models.AcademicYear.findAll({ where: { isActive: true } });
    if (activeYears.length === 1) {
      const activeYearId = activeYears[0].id;
      await models.Class.update({ academicYearId: activeYearId }, { where: { academicYearId: null } });
      await models.Teacher.update({ academicYearId: activeYearId }, { where: { academicYearId: null } });
    }
    console.log("MySQL Connected Successfully");
  } catch (error) {
    // Nested connection errors can have an empty message (e.g. AggregateError).
    // Log only diagnostic fields, never SQL, connection options, or credentials.
    const seen = new Set();
    const describe = (failure) => {
      if (!failure || typeof failure !== "object" || seen.has(failure)) return undefined;
      seen.add(failure);
      const details = {};
      for (const key of ["name", "code", "errno", "syscall", "address", "port", "sqlState"]) {
        if (["string", "number"].includes(typeof failure[key])) details[key] = failure[key];
      }
      for (const key of ["cause", "original", "parent"]) {
        const nested = describe(failure[key]);
        if (nested) details[key] = nested;
      }
      if (Array.isArray(failure.errors)) details.errors = failure.errors.map(describe).filter(Boolean);
      return details;
    };
    console.error("MySQL Connection Failed:", JSON.stringify({ stage, error: describe(error) }));
    process.exit(1);
  }
};
