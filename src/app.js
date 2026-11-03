const express = require("express");
const cors = require("cors");
const path = require("path");

const programRoutes = require("./modules/programs/routes/programRoutes");
const academicYearRoutes = require("./modules/academicYears/routes/academicYearRoutes");
const authRoutes = require("./modules/auth/routes/authRoutes");
const userRoutes = require("./modules/users/routes/userRoutes");
const departmentRoutes = require("./modules/departments/routes/departmentRoutes");
const classRoutes = require("./modules/classes/routes/classRoutes");
const classSectionRoutes = require("./modules/classSections/routes/classSectionRoutes");
const termRoutes = require("./modules/terms/routes/termRoutes");
const subjectRoutes = require("./modules/subjects/routes/subjectRoutes");
const teacherRoutes = require("./modules/teachers/routes/teacherRoutes");
const studentRoutes = require("./modules/students/routes/studentRoutes");
const attendanceRoutes = require("./modules/attendance/routes/attendanceRoutes");
const mobileRoutes = require("./modules/mobile/routes/mobileRoutes");
const teacherAssignmentRoutes = require("./modules/teacherAssignments/routes/teacherAssignmentRoutes");
const examRoutes = require("./modules/exams/routes/examRoutes");
const examSubjectRoutes = require("./modules/examSubjects/routes/examSubjectRoutes");
const examMarkRoutes = require("./modules/examMarks/routes/examMarkRoutes");
const gradingScaleRoutes = require("./modules/gradingScales/routes/gradingScaleRoutes");
const resultRoutes = require("./modules/results/routes/resultRoutes");
const reportRoutes = require("./modules/reports/routes/reportRoutes");
const promotionRoutes = require("./modules/promotions/routes/promotionRoutes");
const promotionRuleRoutes = require("./modules/promotions/routes/promotionRuleRoutes");
const legacyResultRoutes = require("./modules/legacyResults/routes/legacyResultRoutes");
const temporaryAnnualResultRoutes = require("./modules/temporaryAnnualResults/routes/temporaryAnnualResultRoutes");
const disciplineRoutes = require("./modules/discipline/routes/disciplineRoutes");
const teacherCourseContentRoutes = require("./modules/teacherCourseContent/routes/teacherCourseContentRoutes");

const app = express();
const { protect } = require("./middleware/authMiddleware");
const { headDepartmentAccess, portalRoleAccess } = require("./middleware/portalAccessMiddleware");

app.use(cors());
app.use(express.json());
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

// Swagger UI
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use("/api/programs", programRoutes);
app.use("/api/academic-years", academicYearRoutes);
app.use("/api/auth", authRoutes);
app.use("/api", protect, portalRoleAccess, headDepartmentAccess, require("./middleware/attendanceResourceScope"));
app.use("/api/users", userRoutes);
app.use("/api/dashboard", require("./modules/dashboard/dashboardRoutes"));
app.use("/api/departments", departmentRoutes);
app.use("/api/classes", classRoutes);
app.use("/api/class-sections", classSectionRoutes);
app.use("/api/terms", termRoutes);
app.use("/api/subjects", subjectRoutes);
app.use("/api/teachers", teacherRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/internship-rules", require("./modules/attendance/internshipRoutes"));
app.use("/api/mobile", mobileRoutes);
app.use("/api/teacher-assignments", teacherAssignmentRoutes);
app.use("/api/exams", examRoutes);
app.use("/api/exam-subjects", examSubjectRoutes);
app.use("/api/exam-marks", examMarkRoutes);
app.use("/api/grading-scales", gradingScaleRoutes);
app.use("/api/results", resultRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/promotions", promotionRoutes);
app.use("/api/promotion-rules", promotionRuleRoutes);
app.use("/api/legacy-results", legacyResultRoutes);
app.use("/api/temporary-annual-results", temporaryAnnualResultRoutes);
app.use("/api/discipline", disciplineRoutes);
app.use("/api/teacher-course-content", teacherCourseContentRoutes);

app.get("/", (req, res) => {
  res.send("HTI School Management API Running...");
});

module.exports = app;
