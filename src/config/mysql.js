const { Sequelize, DataTypes, Op } = require("sequelize");

const sequelize = new Sequelize(
  process.env.DB_NAME || "hti",
  process.env.DB_USER || "root",
  process.env.DB_PASSWORD || "",
  {
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT || 3306),
    dialect: "mysql",
    logging: process.env.DB_LOGGING === "true" ? console.log : false,
    define: { freezeTableName: true },
  }
);

const models = {};
const refs = {
  ClassSection: { classId: "Class" },
  Student: { academicYearId: "AcademicYear", programId: "Program", departmentId: "Department", classId: "Class", classSectionId: "ClassSection" },
  Class: { programId: "Program", departmentId: "Department", academicYearId: "AcademicYear" },
  Subject: { departmentId: "Department" },
  Teacher: { departmentId: "Department", academicYearId: "AcademicYear" },
  Term: { academicYearId: "AcademicYear" },
  User: { departmentId: "Department", departmentIds: "Department", teacherId: "Teacher" },
  Attendance: { studentId: "Student", academicYearId: "AcademicYear", termId: "Term", classId: "Class", departmentId: "Department", subjectId: "Subject", takenBy: "User" },
  TeacherAssignment: { teacherId: "Teacher", subjectId: "Subject", classId: "Class", departmentId: "Department", academicYearId: "AcademicYear", termId: "Term" },
  Exam: { academicYearId: "AcademicYear", termId: "Term", createdBy: "User" },
  ExamSubject: { examId: "Exam", classId: "Class", subjectId: "Subject", departmentId: "Department" },
  StudentMark: { examId: "Exam", examSubjectId: "ExamSubject", studentId: "Student", academicYearId: "AcademicYear", termId: "Term", classId: "Class", subjectId: "Subject", enteredBy: "User", lastEditedBy: "User" },
  MarkEditHistory: { studentMarkId: "StudentMark", studentId: "Student", examId: "Exam", subjectId: "Subject", editedBy: "User" },
  GradingScale: { programId: "Program" },
  ResultSummary: { examId: "Exam", studentId: "Student", academicYearId: "AcademicYear", termId: "Term", classId: "Class" },
  PromotionRule: { sourceAcademicYearId: "AcademicYear", destinationAcademicYearId: "AcademicYear", programId: "Program", departmentId: "Department", fromClassId: "Class", toClassId: "Class", repeatClassId: "Class" },
  StudentPromotion: { studentId: "Student", examId: "Exam", resultSummaryId: "ResultSummary", fromAcademicYearId: "AcademicYear", toAcademicYearId: "AcademicYear", fromClassId: "Class", toClassId: "Class", processedBy: "User" },
  PromotionCorrection: { promotionId: "StudentPromotion", oldToClassId: "Class", newToClassId: "Class", correctedBy: "User" },
  LegacyResultBatch: { academicYearId: "AcademicYear", termId: "Term", examId: "Exam", departmentId: "Department", classId: "Class", classSectionId: "ClassSection", createdBy: "User", publishedBy: "User" },
  LegacyResultSubject: { batchId: "LegacyResultBatch", examSubjectId: "ExamSubject" },
  LegacyResultStudent: { batchId: "LegacyResultBatch", studentId: "Student" },
  LegacyResultMark: { legacyResultStudentId: "LegacyResultStudent", legacyResultSubjectId: "LegacyResultSubject" },
  LegacyResultMarkEdit: { legacyResultMarkId: "LegacyResultMark", editedBy: "User" },
  LegacyStudentMerge: { mergedBy: "User" },
  TemporaryAnnualBatch: { createdBy: "User", publishedBy: "User" },
  TemporaryAnnualSubject: { batchId: "TemporaryAnnualBatch" },
  TemporaryAnnualStudent: { batchId: "TemporaryAnnualBatch" },
  TemporaryAnnualMark: { studentResultId: "TemporaryAnnualStudent", subjectId: "TemporaryAnnualSubject" },
  DisciplineRecord: { studentId: "Student", academicYearId: "AcademicYear", classId: "Class", departmentId: "Department", reportedBy: "User", resolvedBy: "User" },
  TeacherCourseContent: { teacherId: "Teacher", academicYearId: "AcademicYear" },
  TeacherTermContent: { teacherId: "Teacher", academicYearId: "AcademicYear", termId: "Term" },
  TeacherMonthlyScheme: { teacherId: "Teacher", academicYearId: "AcademicYear", termId: "Term", termContentId: "TeacherTermContent" },
};

const S = (allowNull = true, extra = {}) => ({ type: DataTypes.STRING, allowNull, ...extra });
const I = (allowNull = true, extra = {}) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull, ...extra });
const B = (defaultValue = true) => ({ type: DataTypes.BOOLEAN, allowNull: false, defaultValue });
const D = (allowNull = true) => ({ type: DataTypes.DATE, allowNull });
const E = (values, defaultValue) => ({ type: DataTypes.ENUM(...values), allowNull: defaultValue !== undefined, ...(defaultValue !== undefined && { defaultValue }) });
const N = (allowNull = true, defaultValue) => ({
  type: DataTypes.DECIMAL(8, 2),
  allowNull,
  validate: { min: 0 },
  ...(defaultValue !== undefined && { defaultValue }),
});

function initializeModels() {
  if (models.User) return models;
  const definitions = {
    InternshipRule: { classId: I(false), academicYearId: I(false), classSectionId: I(), weekdays: { type: DataTypes.JSON, allowNull: false }, sessions: { type: DataTypes.JSON, allowNull: false }, remarks: { type: DataTypes.TEXT, allowNull: false }, createdBy: I(false), effectiveFrom: { type: DataTypes.DATEONLY, allowNull: false }, processedThrough: { type: DataTypes.DATEONLY, allowNull: true }, isActive: B() },
    AcademicYear: { name: S(false, { unique: true }), startDate: D(false), endDate: D(false), isActive: B(false), status: E(["ACTIVE", "INACTIVE"], "ACTIVE") },
    Program: { name: E(["Secondary", "Vocational"]), duration: I(false), durationType: E(["Years", "Months"]), description: { type: DataTypes.TEXT }, isActive: B() },
    Department: { name: S(false, { unique: true }), code: S(false, { unique: true }), description: { type: DataTypes.TEXT }, defaultPassMark: N(false, 50), isActive: B() },
    Class: { name: S(false), programId: I(false), departmentId: I(false), academicYearId: I(false), shift: E(["Morning", "Afternoon"], "Morning"), isActive: B() },
    ClassSection: { classId: I(false), name: S(false), capacity: I(), isActive: B() },
    Term: { name: E(["Term 1", "Term 2"]), academicYearId: I(false), startDate: D(false), endDate: D(false), isActive: B() },
    Subject: { name: S(false), code: S(false), subjectType: E(["General", "Core"]), departmentId: I(), hasTheory: B(), hasPractical: B(false), theoryMaxMarks: N(), practicalMaxMarks: N(), hasMonthlyAssessment: B(false), monthlyAssessmentMaxMarks: N(), passMark: N(), isActive: B() },
    Teacher: { fullName: S(false), gender: E(["Male", "Female"]), phone: S(false, { unique: true }), email: S(true, { unique: true }), address: S(), qualification: S(), teacherType: E(["General", "Core"]), departmentId: I(), academicYearId: I(false), hireDate: D(), photoUrl: S(), isActive: B() },
    Student: { admissionNo: S(false, { unique: true }), fullName: S(false), gender: E(["Male", "Female"]), dateOfBirth: D(), phone: S(), address: S(), parentName: S(false), parentPhone: S(false), parentRelationship: E(["Father", "Mother", "Guardian", "Other"], "Guardian"), academicYearId: I(false), programId: I(false), departmentId: I(false), classId: I(false), classSectionId: I(), photoUrl: S(), notaryDocumentUrl: S(), certificateDocumentUrl: S(), status: E(["Active", "Graduated", "Dropped", "Transferred", "Suspended"], "Active"), isActive: B() },
    User: { fullName: S(false), email: S(true, { unique: true }), phone: S(false, { unique: true }), password: S(false), role: E(["SuperAdmin", "Director", "DeputyDirector", "StudentAffairs", "HeadDepartment", "AttendanceTaker", "Teacher", "ExamManager"]), departmentId: I(), departmentIds: { type: DataTypes.JSON, defaultValue: [] }, teacherId: { type: DataTypes.INTEGER, allowNull: true, unique: true }, attendanceShift: E(["Morning", "Afternoon", "All"], "All"), isActive: B() },
    Attendance: { revision: I(false, { defaultValue: 0 }), teacherAssignmentId: I(), lessonId: S(false, { defaultValue: "legacy" }), contextKey: S(true, { unique: true }), studentId: I(false), academicYearId: I(false), termId: I(), classId: I(false), departmentId: I(false), subjectId: { type: DataTypes.INTEGER, allowNull: true }, attendanceDate: D(false), attendanceSession: E(["BeforeBreak", "AfterBreak"], "BeforeBreak"), status: E(["Present", "Absent", "Late", "Permission", "Free", "InternshipVisit"]), remarks: { type: DataTypes.TEXT, defaultValue: "" }, takenBy: I() },
    DailyAttendance: { revision: I(false, { defaultValue: 0 }), contextKey: S(false, { unique: true }), studentId: I(false), academicYearId: I(false), termId: I(false), classId: I(false), departmentId: I(false), attendanceDate: D(false), attendanceSession: E(["BeforeBreak", "AfterBreak"]), status: E(["Present", "Absent", "Late", "Permission", "Free", "InternshipVisit"]), remarks: { type: DataTypes.TEXT }, takenBy: I(false) },
    AttendanceClassAssignment: { userId: I(false), classId: I(false), academicYearId: I(false), termId: I(false), isActive: B() },
    AttendanceAudit: { kind: S(false), recordId: I(false), actorId: I(false), reason: { type: DataTypes.TEXT }, before: { type: DataTypes.JSON }, after: { type: DataTypes.JSON } },
    AttendanceSchedule: { kind: E(["daily", "lesson"]), academicYearId: I(false), termId: I(false), classId: I(false), date: { type: DataTypes.DATEONLY, allowNull: false }, session: E(["BeforeBreak", "AfterBreak"]), lessonId: S(false, { defaultValue: "daily" }), teacherAssignmentId: I(), endsAt: D(false), isSchoolDay: B(), source: S(false), contextKey: S(false, { unique: true }) },
    AttendanceCoverage: { kind: E(["daily", "lesson"]), academicYearId: I(false), termId: I(false), classId: I(false), month: S(false), source: S(false), contextKey: S(false, { unique: true }) },
    TeacherAssignment: { teacherId: I(false), subjectId: I(false), classId: I(false), departmentId: I(false), academicYearId: I(false), termId: I(), isActive: B() },
    Exam: {
      name: S(false),
      examType: E(["ContinuousAssessment", "Midterm", "Final", "Supplementary", "Other"], "Other"),
      academicYearId: I(false),
      termId: I(false),
      startDate: D(),
      endDate: D(),
      status: E(["Draft", "Open", "Published", "Closed"], "Draft"),
      resultsPublished: B(false),
      createdBy: I(false),
    },
    ExamSubject: {
      examId: I(false),
      classId: I(false),
      subjectId: I(false),
      departmentId: I(false),
      hasTheory: B(true),
      hasPractical: B(false),
      hasMonthlyAssessment: B(false),
      monthlyAssessmentMaxMarks: N(true, 0),
      theoryMaxMarks: N(false, 0),
      practicalMaxMarks: N(false, 0),
      totalMaxMarks: N(false),
      passMark: N(false),
      isActive: B(),
    },
    StudentMark: {
      examId: I(false),
      examSubjectId: I(false),
      studentId: I(false),
      academicYearId: I(false),
      termId: I(false),
      classId: I(false),
      subjectId: I(false),
      theoryMark: N(),
      practicalMark: N(),
      monthlyAssessmentMark: N(),
      totalMark: N(),
      percentage: { type: DataTypes.DECIMAL(6, 2), allowNull: true, validate: { min: 0, max: 100 } },
      grade: S(),
      resultStatus: E(["Pass", "Fail", "Absent", "Exempted", "Missing"], "Missing"),
      remarks: { type: DataTypes.TEXT, defaultValue: "" },
      entryMethod: E(["Manual", "Excel"], "Manual"),
      sourceFileName: S(),
      enteredBy: I(false),
      lastEditedBy: I(),
    },
    MarkEditHistory: {
      studentMarkId: I(false),
      studentId: I(false),
      examId: I(false),
      subjectId: I(false),
      oldTheoryMark: N(),
      newTheoryMark: N(),
      oldPracticalMark: N(),
      newPracticalMark: N(),
      oldMonthlyAssessmentMark: N(),
      newMonthlyAssessmentMark: N(),
      oldTotalMark: N(),
      newTotalMark: N(),
      reason: { type: DataTypes.TEXT, allowNull: true },
      editedBy: I(false),
    },
    GradingScale: {
      name: S(false),
      programId: I(false),
      minimumPercentage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, validate: { min: 0, max: 100 } },
      maximumPercentage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, validate: { min: 0, max: 100 } },
      grade: S(false),
      remark: S(),
      gradePoint: { type: DataTypes.DECIMAL(5, 2), allowNull: true, validate: { min: 0 } },
      isPass: B(false),
      isActive: B(),
    },
    ResultSummary: {
      examId: I(false),
      studentId: I(false),
      academicYearId: I(false),
      termId: I(false),
      classId: I(false),
      totalMarksObtained: N(false, 0),
      totalMaximumMarks: N(false, 0),
      averagePercentage: { type: DataTypes.DECIMAL(6, 2), allowNull: true, validate: { min: 0, max: 100 } },
      grade: S(),
      subjectsTaken: I(false, { defaultValue: 0 }),
      subjectsPassed: I(false, { defaultValue: 0 }),
      subjectsFailed: I(false, { defaultValue: 0 }),
      subjectsExempted: I(false, { defaultValue: 0 }),
      subjectsMissing: I(false, { defaultValue: 0 }),
      classPosition: I(),
      overallStatus: E(["Pass", "Fail", "Incomplete"], "Incomplete"),
      calculatedAt: D(false),
    },
    PromotionRule: {
      sourceAcademicYearId: I(false),
      destinationAcademicYearId: I(false),
      programId: I(false),
      departmentId: I(false),
      fromClassId: I(false),
      toClassId: I(),
      repeatClassId: I(),
      minimumAverage: { type: DataTypes.DECIMAL(6, 2), allowNull: false, validate: { min: 0, max: 100 } },
      maximumFailedSubjects: I(false, { defaultValue: 0 }),
      isFinalClass: B(false),
      isActive: B(),
    },
    StudentPromotion: {
      studentId: I(false),
      examId: I(false),
      resultSummaryId: I(false),
      fromAcademicYearId: I(false),
      toAcademicYearId: I(false),
      fromClassId: I(false),
      toClassId: I(),
      averagePercentage: { type: DataTypes.DECIMAL(6, 2), allowNull: true, validate: { min: 0, max: 100 } },
      failedSubjects: I(false, { defaultValue: 0 }),
      decision: E(["Promoted", "Repeated", "Graduated", "Held"], "Held"),
      reason: { type: DataTypes.TEXT, allowNull: true },
      processedBy: I(false),
      processedAt: D(false),
    },
    PromotionCorrection: {
      promotionId: I(false),
      oldDecision: E(["Promoted", "Repeated", "Graduated", "Held"]),
      newDecision: E(["Promoted", "Repeated", "Graduated", "Held"]),
      oldToClassId: I(),
      newToClassId: I(),
      reason: { type: DataTypes.TEXT, allowNull: false },
      correctedBy: I(false),
      correctedAt: D(false),
    },
    LegacyResultBatch: {
      academicYearId: I(false), termId: I(false), examId: I(false), departmentId: I(false),
      classId: I(false), classSectionId: I(), sourceFilename: S(false), worksheetName: S(false),
      ngStatus: E(["Missing", "Absent"]), status: E(["Draft", "Validated", "Published", "Archived"], "Draft"),
      createdBy: I(false), publishedBy: I(), publishedAt: D(),
    },
    LegacyResultSubject: {
      batchId: I(false), excelHeading: S(false), examSubjectId: I(false), displayOrder: I(false),
    },
    LegacyResultStudent: {
      batchId: I(false), studentId: I(), legacyStudentKey: S(), admissionNo: S(), originalStudentName: S(false), importedTotal: N(), importedResult: S(),
    },
    LegacyResultMark: {
      legacyResultStudentId: I(false), legacyResultSubjectId: I(false), mark: N(),
      markStatus: E(["Present", "Missing", "Absent", "Cheated"], "Present"), rawValue: S(),
    },
    LegacyResultMarkEdit: {
      legacyResultMarkId: I(false), oldMark: N(), newMark: N(), oldStatus: S(false),
      newStatus: S(false), reason: { type: DataTypes.TEXT, allowNull: false }, editedBy: I(false),
    },
    LegacyStudentMerge: {
      sourceKey: S(false), targetKey: S(false), reason: { type: DataTypes.TEXT, allowNull: false },
      rowsMoved: I(false), mergedBy: I(false),
    },
    TemporaryAnnualBatch: {
      academicYear: S(false), departmentName: S(false), className: S(false), sectionName: S(),
      sourceFilename: S(false), worksheetName: S(false), ngStatus: E(["Missing", "Absent"]),
      passMark: N(false, 50), status: E(["Validated", "Published", "Archived"], "Validated"), createdBy: I(false), publishedBy: I(), publishedAt: D(),
    },
    TemporaryAnnualSubject: {
      batchId: I(false), term: E(["TermOne", "TermTwo"]), heading: S(false), displayOrder: I(false), maximumMark: N(false, 100),
    },
    TemporaryAnnualStudent: {
      batchId: I(false), studentReference: S(false), studentName: S(false), termOneTotal: N(), termTwoTotal: N(),
    },
    TemporaryAnnualMark: {
      studentResultId: I(false), subjectId: I(false), mark: N(), markStatus: E(["Present", "Missing", "Absent", "Cheated"], "Present"), rawValue: S(),
    },
    DisciplineRecord: {
      studentId: I(false), academicYearId: I(false), classId: I(false), departmentId: I(false),
      incidentDate: D(false), category: S(false), description: { type: DataTypes.TEXT, allowNull: false },
      severity: E(["Low", "Medium", "High", "Critical"], "Medium"), actionTaken: { type: DataTypes.TEXT },
      status: E(["Open", "Resolved"], "Open"), notes: { type: DataTypes.TEXT }, reportedBy: I(false), resolvedBy: I(), resolvedAt: D(),
    },
    TeacherCourseContent: {
      teacherId: I(false), academicYearId: I(false), month: I(false), courseTitle: S(false),
      content: { type: DataTypes.TEXT, allowNull: false }, schemeOfWorkUrl: S(), originalFileName: S(), isActive: B(),
    },
    TeacherTermContent: {
      teacherId: I(false), academicYearId: I(false), termId: I(false), courseTitle: S(false),
      chaptersTopics: { type: DataTypes.TEXT, allowNull: false }, documentUrl: S(), originalFileName: S(), isActive: B(),
    },
    TeacherMonthlyScheme: {
      teacherId: I(false), academicYearId: I(false), termId: I(false), termContentId: I(false), month: I(false),
      teachingPlan: { type: DataTypes.TEXT, allowNull: false }, documentUrl: S(), originalFileName: S(), isActive: B(),
    },
  };
  for (const [name, attributes] of Object.entries(definitions)) {
    const indexes = [];
    if (name === "InternshipRule") indexes.push({ name: "idx_internship_rule_scope", fields: ["academicYearId", "classId", "isActive"] });
    if (name === "AttendanceClassAssignment") indexes.push({ name: "uq_attendance_class_user", unique: true, fields: ["userId", "classId", "academicYearId", "termId"] });
    if (name === "Student") indexes.push(
      { name: "idx_student_scope_active", fields: ["departmentId", "classId", "academicYearId", "isActive"] },
      { name: "idx_student_full_name", fields: ["fullName"] }
    );
    if (name === "Subject") indexes.push({ name: "uq_subject_code_department", unique: true, fields: ["code", "departmentId"] });
    if (name === "ClassSection") indexes.push({ name: "uq_class_section_name", unique: true, fields: ["classId", "name"] });
    if (name === "TeacherAssignment") indexes.push({ name: "uq_teacher_assignment", unique: true, fields: ["teacherId", "subjectId", "classId", "academicYearId", "termId"] });
    if (name === "Exam") indexes.push({ name: "uq_exam_name_year_term", unique: true, fields: ["name", "academicYearId", "termId"] });
    if (name === "ExamSubject") indexes.push({ name: "uq_exam_class_subject", unique: true, fields: ["examId", "classId", "subjectId"] });
    if (name === "StudentMark") indexes.push({ name: "uq_exam_student_subject", unique: true, fields: ["examId", "studentId", "subjectId"] });
    if (name === "MarkEditHistory") indexes.push({ name: "idx_mark_history_mark", fields: ["studentMarkId", "createdAt"] });
    if (name === "GradingScale") indexes.push({ name: "uq_program_grade", unique: true, fields: ["programId", "grade"] });
    if (name === "ResultSummary") indexes.push({ name: "uq_exam_student_result", unique: true, fields: ["examId", "studentId"] });
    if (name === "PromotionRule") indexes.push({ name: "uq_promotion_rule", unique: true, fields: ["sourceAcademicYearId", "fromClassId", "destinationAcademicYearId"] });
    if (name === "StudentPromotion") indexes.push({ name: "uq_student_promotion_year", unique: true, fields: ["studentId", "toAcademicYearId"] });
    if (name === "PromotionCorrection") indexes.push({ name: "idx_promotion_correction", fields: ["promotionId", "correctedAt"] });
    if (name === "LegacyResultBatch") indexes.push({ name: "idx_legacy_batch_scope", fields: ["academicYearId", "termId", "classId", "classSectionId", "status"] });
    if (name === "LegacyResultSubject") {
      indexes.push({ name: "uq_legacy_subject_heading", unique: true, fields: ["batchId", "excelHeading"] });
      indexes.push({ name: "uq_legacy_subject_mapping", unique: true, fields: ["batchId", "examSubjectId"] });
    }
    if (name === "LegacyResultStudent") indexes.push({ name: "uq_legacy_batch_student", unique: true, fields: ["batchId", "studentId"] });
    if (name === "LegacyResultStudent") indexes.push({ name: "idx_legacy_student_key", fields: ["legacyStudentKey"] });
    if (name === "LegacyResultMark") indexes.push({ name: "uq_legacy_student_subject", unique: true, fields: ["legacyResultStudentId", "legacyResultSubjectId"] });
    if (name === "LegacyResultMarkEdit") indexes.push({ name: "idx_legacy_mark_edit", fields: ["legacyResultMarkId", "createdAt"] });
    if (name === "LegacyStudentMerge") indexes.push({ name: "idx_legacy_student_merge", fields: ["sourceKey", "targetKey", "createdAt"] });
    if (name === "TemporaryAnnualBatch") indexes.push({ name: "idx_temp_annual_year_status", fields: ["academicYear", "status"] });
    if (name === "TemporaryAnnualSubject") indexes.push({ name: "uq_temp_annual_subject", unique: true, fields: ["batchId", "term", "heading"] });
    if (name === "TemporaryAnnualStudent") indexes.push({ name: "uq_temp_annual_student", unique: true, fields: ["batchId", "studentReference"] });
    if (name === "TemporaryAnnualMark") indexes.push({ name: "uq_temp_annual_mark", unique: true, fields: ["studentResultId", "subjectId"] });
    if (name === "DisciplineRecord") indexes.push(
      { name: "idx_discipline_student_date", fields: ["studentId", "incidentDate"] },
      { name: "idx_discipline_department_status", fields: ["departmentId", "status"] }
    );
    if (name === "TeacherCourseContent") indexes.push(
      { name: "idx_teacher_content_scope", fields: ["teacherId", "academicYearId", "month"] }
    );
    if (name === "TeacherTermContent") indexes.push({ name: "uq_teacher_term_course", unique: true, fields: ["teacherId", "academicYearId", "termId", "courseTitle"] });
    if (name === "TeacherMonthlyScheme") indexes.push({ name: "uq_teacher_monthly_scheme", unique: true, fields: ["termContentId", "month"] });
    const options = { tableName: `${name.toLowerCase()}s`, indexes };
    if (name === "Exam") {
      options.validate = {
        dateRange() {
          if (this.startDate && this.endDate && this.endDate < this.startDate) {
            throw new Error("Exam end date must be on or after its start date");
          }
        },
      };
    }
    if (name === "ExamSubject") {
      options.validate = {
        markConfiguration() {
          const theory = Number(this.theoryMaxMarks || 0);
          const practical = Number(this.practicalMaxMarks || 0);
          const total = Number(this.totalMaxMarks || 0);
          const pass = Number(this.passMark || 0);
          if (!this.hasTheory && !this.hasPractical) throw new Error("An exam subject must have theory or practical marks");
          if (!this.hasTheory && theory !== 0) throw new Error("Theory maximum must be zero when theory is disabled");
          if (!this.hasPractical && practical !== 0) throw new Error("Practical maximum must be zero when practical is disabled");
          if (total <= 0 || total !== Number(((this.hasTheory ? theory : 0) + (this.hasPractical ? practical : 0) + (this.hasMonthlyAssessment ? Number(this.monthlyAssessmentMaxMarks) : 0)).toFixed(2))) throw new Error("Total maximum must equal the enabled component maxima");
          if (pass > total) throw new Error("Pass mark cannot exceed total maximum marks");
        },
      };
    }
    if (name === "GradingScale") {
      options.validate = {
        percentageRange() {
          if (Number(this.minimumPercentage) > Number(this.maximumPercentage)) {
            throw new Error("Minimum percentage cannot exceed maximum percentage");
          }
        },
      };
    }
    models[name] = sequelize.define(name, attributes, options);
  }
  return models;
}

function where(input = {}) {
  const out = {};
  for (const [rawKey, value] of Object.entries(input || {})) {
    const key = rawKey === "_id" ? "id" : rawKey;
    if (rawKey === "$or") { out[Op.or] = value.map(where); continue; }
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      const x = {};
      if (value.$in) x[Op.in] = value.$in;
      if (value.$gte !== undefined) x[Op.gte] = value.$gte;
      if (value.$lt !== undefined) x[Op.lt] = value.$lt;
      out[key] = Reflect.ownKeys(x).length ? x : value;
    } else out[key] = value;
  }
  return out;
}

function document(instance, hidden = []) {
  if (!instance) return null;
  const obj = instance.get({ plain: true });
  obj._id = obj.id;
  for (const field of hidden) delete obj[field];
  Object.defineProperty(obj, "save", { enumerable: false, value: async () => {
    const values = { ...obj }; delete values._id; delete values.id;
    await instance.update(values); return document(instance, hidden);
  }});
  return obj;
}

class Query {
  constructor(name, type, filters, update) { this.name = name; this.type = type; this.filters = filters; this.update = update; this.order = []; this.pops = []; this.hidden = []; }
  sort(spec) { this.order = Object.entries(spec).map(([k,v]) => [k === "_id" ? "id" : k, v === -1 ? "DESC" : "ASC"]); return this; }
  select(spec) { this.hidden = String(spec).split(/\s+/).filter(x => x[0] === "-").map(x => x.slice(1)); return this; }
  populate(spec) { this.pops.push(typeof spec === "string" ? { path: spec } : spec); return this; }
  async exec() {
    initializeModels(); const M = models[this.name]; let result;
    const options = { where: where(this.filters), order: this.order };
    if (this.type === "many") result = await M.findAll(options);
    else if (this.type === "one") result = await M.findOne(options);
    else if (this.type === "update") { const row = await M.findOne(options); if (row) await row.update(this.update); result = row; }
    else if (this.type === "delete") { const row = await M.findOne(options); if (row) await row.destroy(); result = row; }
    let docs = Array.isArray(result) ? result.map(x => document(x, this.hidden)) : document(result, this.hidden);
    const list = Array.isArray(docs) ? docs : docs ? [docs] : [];
    for (const pop of this.pops) for (const doc of list) {
      const target = refs[this.name]?.[pop.path];
      if (target && doc[pop.path] != null) {
        if (Array.isArray(doc[pop.path])) {
          const rows = await models[target].findAll({ where: { id: { [Op.in]: doc[pop.path] } } });
          doc[pop.path] = rows.map(row => document(row, pop.select === "-password" ? ["password"] : []));
        } else {
          const row = await models[target].findByPk(doc[pop.path]);
          doc[pop.path] = document(row, pop.select === "-password" ? ["password"] : []);
        }
      }
    }
    return docs;
  }
  then(resolve, reject) { return this.exec().then(resolve, reject); }
}

function model(name) {
  initializeModels();
  return {
    find: (f={}) => new Query(name, "many", f), findOne: (f={}) => new Query(name, "one", f),
    findById: id => new Query(name, "one", { id }),
    findByIdAndUpdate: (id,u) => new Query(name, "update", { id }, u),
    findByIdAndDelete: id => new Query(name, "delete", { id }),
    create: async data => document(await models[name].create(data)),
    insertMany: async rows => Promise.all(rows.map(async r => document(await models[name].create(r)))),
    updateMany: async (f,u) => models[name].update(u, { where: where(f) }),
    aggregate: async pipeline => {
      const match = pipeline.find(x => x.$match)?.$match || {}; const group = pipeline.find(x => x.$group)?.$group?._id;
      const fields = typeof group === "string" ? [group.slice(1)] : Object.values(group || {}).map(x => x.slice(1));
      const rows = await models[name].findAll({ where: where(match), attributes: [...fields, [sequelize.fn("COUNT", sequelize.col("id")), "count"]], group: fields, raw: true });
      return rows.map(r => ({ _id: typeof group === "string" ? r[fields[0]] : Object.fromEntries(Object.keys(group).map((k,i) => [k,r[fields[i]]])), count: Number(r.count) }));
    },
  };
}

module.exports = { sequelize, initializeModels, model };
