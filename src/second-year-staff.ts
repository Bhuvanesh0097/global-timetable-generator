import type { StaffMember, TimetableSetup } from './models.ts'

/** Global staff master is the only source of truth. Legacy department-specific records are intentionally not loaded. */
export const secondYearStaff: Record<string, StaffMember[]> = {}

export function createStaffOnlySecondYearConfiguration(department: string, staff: StaffMember[], academicYear: string): TimetableSetup {
  return {
    academic: { department, academicYear, year: 'II / 2nd Year', semester: 'V / 5th Semester' },
    staff,
    sections: [],
    coreSubjects: [],
    otherSubjectMaster: [],
    otherSubjects: [],
    labMaster: [],
    labAssignments: [],
    specialActivities: [],
    sectionSubjectAssignments: [],
    specialActivityAssignments: [],
  }
}
