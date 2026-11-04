const Attendance = require("../../../config/mysql").model("DailyAttendance");
const Class = require("../../classes/models/Class");
const Student = require("../../students/models/Student");
const ClassSection = require("../../classSections/models/ClassSection");
const TeacherAssignment = require("../../teacherAssignments/models/TeacherAssignment");
const { departmentIds, id, fail, attendanceDate, schoolToday } = require("../../attendance/attendanceDomain");

const uniqueIds = (ids) => [
  ...new Set((ids || []).filter(Boolean).map((id) => id.toString())),
];

const normalizeAttendanceShift = (shift) => {
  const normalizedShift = String(shift || "").trim().toLowerCase();

  if (!normalizedShift || normalizedShift === "all") {
    return null;
  }

  if (normalizedShift === "morning") {
    return "Morning";
  }

  if (normalizedShift === "afternoon") {
    return "Afternoon";
  }

  return shift;
};

const applyAttendanceShiftFilter = (filters, user) => {
  const attendanceShift = normalizeAttendanceShift(user.attendanceShift);

  if (attendanceShift) {
    filters.shift = attendanceShift;
  }
};

const assignedClassFilters = async (user) => {
  const filters = { isActive: true };
  if (user.role === "Teacher") {
    const assignments = user.teacherId ? await TeacherAssignment.find({ teacherId: user.teacherId, isActive: true }) : [];
    filters._id = { $in: uniqueIds(assignments.map(a => a.classId)) };
  } else if (user.role === "AttendanceTaker") {
    filters.departmentId = { $in: departmentIds(user) };
  } else {
    let departmentIds = user.departmentIds || [];
    if (typeof departmentIds === "string") {
      try { departmentIds = JSON.parse(departmentIds); } catch { departmentIds = []; }
    }
    filters.departmentId = { $in: uniqueIds([
      ...(Array.isArray(departmentIds) ? departmentIds : []),
      user.departmentId,
    ]) };
  }
  applyAttendanceShiftFilter(filters, user);
  return filters;
};

exports.getAssignedAttendanceClasses = async (req, res) => {
  const Attendance = require("../../../config/mysql").model(req.user.role === "Teacher" ? "Attendance" : "DailyAttendance");
  try {
    const classFilters = await assignedClassFilters(req.user);
    if (req.query.departmentId) {
      const selected = id(req.query.departmentId);
      if (req.user.role === "AttendanceTaker" && !departmentIds(req.user).includes(selected)) fail("Department is outside your assignments", 403);
      classFilters.departmentId = selected;
    }

    const classes = await Class.find(classFilters)
      .populate("departmentId")
      .populate("programId")
      .populate("academicYearId")
      .sort({ createdAt: -1 });

    const classIds = classes.map((classItem) => classItem._id);

    const selectedDate = attendanceDate(req.query.date === undefined ? schoolToday() : req.query.date);
    const startOfDate = new Date(`${selectedDate}T00:00:00Z`);
    const endOfDate = new Date(startOfDate);
    endOfDate.setUTCDate(endOfDate.getUTCDate() + 1);

    const [studentCounts, selectedAttendanceStats] = await Promise.all([
      Student.aggregate([
        {
          $match: {
            classId: { $in: classIds },
            isActive: true,
          },
        },
        {
          $group: {
            _id: "$classId",
            count: { $sum: 1 },
          },
        },
      ]),
      Attendance.aggregate([
        {
          $match: {
            classId: { $in: classIds },
            ...(req.user.role === "Teacher" ? { takenBy: req.user._id || req.user.id } : {}),
            attendanceDate: {
              $gte: startOfDate,
              $lt: endOfDate,
            },
          },
        },
        {
          $group: {
            _id: {
              classId: "$classId",
              attendanceSession: "$attendanceSession",
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    const studentCountByClassId = new Map(
      studentCounts.map((item) => [item._id.toString(), item.count])
    );
    const attendanceStatsByClassId = new Map();

    selectedAttendanceStats.forEach((item) => {
      const classId = item._id.classId.toString();
      const stats = attendanceStatsByClassId.get(classId) || {
        BeforeBreak: 0,
        AfterBreak: 0,
      };

      stats[item._id.attendanceSession || "BeforeBreak"] = item.count;
      attendanceStatsByClassId.set(classId, stats);
    });

    const departmentsById = new Map();
    const classData = classes.map((classItem) => {
      const department = classItem.departmentId;
      const departmentId = department?._id?.toString();
      const classId = classItem._id.toString();
      const studentsCount = studentCountByClassId.get(classId) || 0;
      const attendanceStats = attendanceStatsByClassId.get(classId) || {
        BeforeBreak: 0,
        AfterBreak: 0,
      };
      const beforeBreakDone =
        studentsCount > 0 && attendanceStats.BeforeBreak >= studentsCount;
      const afterBreakDone =
        studentsCount > 0 && attendanceStats.AfterBreak >= studentsCount;
      const doneToday = beforeBreakDone && afterBreakDone;

      if (departmentId && !departmentsById.has(departmentId)) {
        departmentsById.set(departmentId, {
          id: departmentId,
          name: department.name,
          code: department.code,
        });
      }

      return {
        id: classId,
        name: classItem.name,
        displayCode: department?.code
          ? `${department.code}-${classItem.name.replace(/^class\s+/i, "")}`
          : classItem.name,
        department: department
          ? {
              id: departmentId,
              name: department.name,
              code: department.code,
            }
          : null,
        program: classItem.programId
          ? {
              id: classItem.programId._id,
              name: classItem.programId.name,
            }
          : null,
        shift: classItem.shift,
        academicYear: classItem.academicYearId
          ? {
              id: classItem.academicYearId._id,
              name: classItem.academicYearId.name,
            }
          : null,
        studentsCount,
        attendanceToday: {
          beforeBreak: {
            submitted: attendanceStats.BeforeBreak,
            done: beforeBreakDone,
          },
          afterBreak: {
            submitted: attendanceStats.AfterBreak,
            done: afterBreakDone,
          },
          dayComplete: doneToday,
        },
        doneToday,
      };
    });
    const completedClassesCount = classData.filter(
      (classItem) => classItem.doneToday
    ).length;

    res.status(200).json({
      message: "Assigned classes fetched successfully",
      attendanceDate: selectedDate,
      summary: {
        departments: departmentsById.size,
        classes: classData.length,
        done: completedClassesCount,
      },
      departments: Array.from(departmentsById.values()),
      classes: classData,
    });
  } catch (error) {
    res.status(error.status || 500).json({
      message: error.message,
    });
  }
};

exports.getAssignedClassStudents = async (req, res) => {
  const Attendance = require("../../../config/mysql").model(req.user.role === "Teacher" ? "Attendance" : "DailyAttendance");
  try {
    const classFilters = await assignedClassFilters(req.user);
    if (classFilters._id && !classFilters._id.$in.includes(String(req.params.classId))) {
      return res.status(404).json({ message: "Class not found in your active teacher assignments" });
    }
    classFilters._id = req.params.classId;

    const classItem = await Class.findOne(classFilters)
      .populate("departmentId")
      .populate("programId")
      .populate("academicYearId");

    if (!classItem) {
      return res.status(404).json({
        message: "Class not found in your assignments",
      });
    }

    const sections = await ClassSection.find({ classId: classItem._id, isActive: true }).sort({ name: 1 });
    const sectionId = req.query.classSectionId ? id(req.query.classSectionId) : null;
    if (sectionId && !sections.some(section => Number(section._id) === sectionId)) {
      return res.status(404).json({ message: "Section not found in this class" });
    }

    const selectedDate = attendanceDate(req.query.date === undefined ? schoolToday() : req.query.date);
    const startOfDate = new Date(`${selectedDate}T00:00:00Z`);
    const endOfDate = new Date(startOfDate);
    endOfDate.setUTCDate(endOfDate.getUTCDate() + 1);

    const [students, selectedAttendance] = await Promise.all([
      Student.find({
        classId: classItem._id,
        ...(sectionId ? { classSectionId: sectionId } : {}),
        isActive: true,
      }).sort({ fullName: 1 }),
      Attendance.find({
        classId: classItem._id,
        ...(req.user.role === "Teacher" ? { takenBy: req.user._id || req.user.id } : {}),
        attendanceDate: {
          $gte: startOfDate,
          $lt: endOfDate,
        },
      }),
    ]);

    const department = classItem.departmentId;
    const classNameSuffix = classItem.name.replace(/^class\s+/i, "");

    res.status(200).json({
      message: "Class students fetched successfully",
      attendanceDate: selectedDate,
      class: {
        id: classItem._id,
        name: classItem.name,
        displayCode: department?.code
          ? `${department.code}-${classNameSuffix}`
          : classItem.name,
        department: department
          ? {
              id: department._id,
              name: department.name,
              code: department.code,
            }
          : null,
        program: classItem.programId
          ? {
              id: classItem.programId._id,
              name: classItem.programId.name,
            }
          : null,
        shift: classItem.shift,
        academicYear: classItem.academicYearId
          ? {
              id: classItem.academicYearId._id,
              name: classItem.academicYearId.name,
            }
          : null,
      },
      count: students.length,
      sections: sections.map(section => ({ id: section._id, name: section.name })),
      selectedSectionId: sectionId,
      students: students.map((student) => {
        const studentAttendance = selectedAttendance
          .filter(
            (attendance) =>
              attendance.studentId.toString() === student._id.toString()
          )
          .reduce(
            (sessions, attendance) => ({
              ...sessions,
              [attendance.attendanceSession || "BeforeBreak"]: {
                id: attendance._id,
                status: attendance.status,
                remarks: attendance.remarks,
                attendanceDate: attendance.attendanceDate,
                revision: attendance.revision,
                updatedAt: attendance.updatedAt,
                termId: attendance.termId,
              },
            }),
            {}
          );

        return {
          id: student._id,
          admissionNo: student.admissionNo,
          fullName: student.fullName,
          gender: student.gender,
          photoUrl: student.photoUrl,
          status: student.status,
          classSectionId: student.classSectionId || null,
          attendanceToday: {
            beforeBreak: studentAttendance.BeforeBreak || null,
            afterBreak: studentAttendance.AfterBreak || null,
            dayComplete: Boolean(
              studentAttendance.BeforeBreak && studentAttendance.AfterBreak
            ),
          },
        };
      }),
    });
  } catch (error) {
    res.status(error.status || 500).json({
      message: error.message,
    });
  }
};

exports.getAssignedAttendanceDepartments = async (req, res) => {
  try {
    const Department = require("../../../config/mysql").model("Department");
    const departments = await Department.find({ _id: { $in: departmentIds(req.user) } }).sort({ name: 1 });
    res.json({ count: departments.length, departments });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message });
  }
};
