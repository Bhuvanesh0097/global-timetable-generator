import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { secondYearStaff, createStaffOnlySecondYearConfiguration } from '../src/second-year-staff.ts'
import { globalStaffIds } from '../src/staff-identities.ts'

const expectedByDepartment = {
  MECH: ['Mr. S. Ravichandran', 'Mr. B. Vasanth', 'Dr. A. Mathiarasu', 'Mr. A. Thiagarajan', 'Mr. S. Ganeshkumar', 'Dr. P. Natarajan', 'Mr. V. Mohan'],
  RA: ['Mr. Parasu Raman', 'Mr. Ganeshkumar S', 'Mrs. T. Sudha', 'Mr. A. Baskaran', 'Mrs. D. Dharani', 'Ms. L. Bhuvaneswari', 'Dr. V. Govindan'],
  FT: ['Mr. L. Vimal Raj', 'Dr. D. Tiroutchelvame', 'Dr. T. Radhika', 'Dr. R. Rajalakshmi', 'Ms. S. Meenambigai', 'Dr. A. Bargavi @ Meanachi'],
  IOT: ['Mrs. S. Aruljothi', 'Mrs. Sherly Metilda Dennis', 'Mr. V. Kumaraguru', 'Ms. S. Adolphine Shyni', 'Mr. P. Sivasankar'],
  AIML: ['Mrs. Diana. S. Steffi', 'Mr. R. Raj Bharath', 'Mrs. T. Raj Sundari', 'Mrs. Nandhini', 'Mrs. S. Chitra', 'Mr. V. Mohan', 'Mrs. Radha', 'Mrs. S. K. Sugnedham', 'Mrs. P. Suganya', 'Mrs. S. Lavanya', 'Mrs. V. Niraimathi', 'Mrs. K. Revathy'],
  ECE: ['Mr. S. Ravichandran', 'Mrs. R. Vijayalakshmi', 'Mr. R. Sambath Kumar', 'Mrs. P. Ranjitha', 'Dr. S. Anbazhagan', 'Mrs. M. Subashree', 'Mr. R. Sathyamoorthy', 'Dr. P. Mohan', 'Dr. S. Shanthi', 'Dr. M. Sivasindhu', 'Dr. S. Semmalar', 'Mrs. Adhi Vaishnavi', 'Mr. D. Poobalan'],
  EEE: ['Mr. R. Parasuraman', 'Mr. J. Vijayaraghavan', 'Mr. R. Goutham Govind Raju', 'Mr. K. Rajesh', 'Mr. D. Balaji', 'Mr. S. Rajkumar', 'Mrs. R. Priya'],
}

test('second-year staff-only masters contain the requested identifiable staff and no placeholders', () => {
  assert.deepEqual(Object.keys(secondYearStaff).sort(), ['AIML', 'ECE', 'EEE', 'FT', 'IOT', 'MECH', 'RA'])

  for (const [department, expectedNames] of Object.entries(expectedByDepartment)) {
    const staff = secondYearStaff[department]
    assert.deepEqual(staff.map(({ name }) => name), expectedNames, department)
    assert.equal(new Set(staff.map(({ id }) => id)).size, staff.length, `${department} has unique staff IDs`)
    assert.ok(staff.every(({ name }) => !/new staff|ethnotech/i.test(name)), `${department} excludes placeholders and organizations`)

    const setup = createStaffOnlySecondYearConfiguration(department, staff, '2026 - 2027')
    assert.equal(setup.academic.department, department)
    assert.equal(setup.academic.year, 'II / 2nd Year')
    assert.deepEqual(setup.sections, [])
    assert.deepEqual(setup.coreSubjects, [])
    assert.deepEqual(setup.otherSubjectMaster, [])
    assert.deepEqual(setup.otherSubjects, [])
    assert.deepEqual(setup.labMaster, [])
    assert.deepEqual(setup.labAssignments, [])
    assert.deepEqual(setup.specialActivities, [])
    assert.deepEqual(setup.sectionSubjectAssignments, [])
    assert.deepEqual(setup.specialActivityAssignments, [])
  }
})

test('staff identities already represented in other department/year masters reuse their IDs', () => {
  const getId = (department, name) => secondYearStaff[department].find((person) => person.name === name)?.id
  assert.equal(getId('MECH', 'Mr. S. Ravichandran'), globalStaffIds.mrSRavichandran)
  assert.equal(getId('ECE', 'Mr. S. Ravichandran'), globalStaffIds.mrSRavichandran)
  assert.equal(getId('MECH', 'Dr. A. Mathiarasu'), globalStaffIds.drAMathiarasu)
  assert.equal(getId('MECH', 'Dr. P. Natarajan'), globalStaffIds.drPNatarajan)
  assert.equal(getId('AIML', 'Mrs. Nandhini'), 'staff-nandhini')
  assert.equal(getId('AIML', 'Mr. V. Mohan'), 'cse2-staff-mohan')
  assert.equal(getId('ECE', 'Mrs. M. Subashree'), 'staff-subashree')
  assert.equal(getId('EEE', 'Mrs. R. Priya'), 'aiml-staff-priya')
})

test('existing CSE second-year Staff Master covers the source union without changing its entries', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const block = source.match(/const cseSecondYearStaff: StaffMember\[\] = \[([\s\S]*?)\n\]/)?.[1]
  assert.ok(block, 'CSE second-year staff list exists')
  const entries = [...block.matchAll(/\{ id: '([^']+)', name: '([^']+)' \}/g)].map(([, id, name]) => ({ id, name }))
  const names = entries.map(({ name }) => name)
  const normalized = (name) => name.toLowerCase().replace(/^(mrs?|miss|ms|dr)\.?\s*/i, '').replace(/[.\s]/g, '')
  const aliases = new Map([
    [normalized('Mr. Kishore'), [normalized('Mr. Kishor')]],
  ])
  const hasName = (name) => {
    const key = normalized(name)
    return names.some((candidate) => normalized(candidate) === key || aliases.get(key)?.includes(normalized(candidate)))
  }
  const requested = [
    'Mrs. Elakkiya', 'Dr. J. Vaishnavi', 'Mrs. R. Indumathi', 'Mr. Kameshwaran',
    'Miss. A. Suganthi', 'Mrs. S. Boovaneswari', 'Mrs. J. Jayapradha', 'Mr. Kishore',
    'Mrs. G. Sharmila', 'Mrs. M. Subashree', 'Mr. V. Mohan', 'Mrs. D. Mohana Priya',
    'Mr. Jayson', 'Mrs. Sheelarani', 'Mrs. Sathyavani', 'Mr. L. Vimal Raj',
    'Mr. R. Sathishkumar', 'Mr. N. Arikaran', 'Mrs. Kalpana', 'Mrs. Devanadhan',
    'Mr. R. Sathyamoorthy', 'Mrs. R. Athivaishnavi', 'Mrs. Nandhini',
  ]
  assert.ok(requested.every(hasName), 'all identifiable names from CSE Sections A–D are present')
  assert.equal(entries.length, 24, 'no CSE Staff Master entries were added or removed')
  assert.notEqual(entries.find(({ name }) => name.includes('Sathishkumar'))?.id, entries.find(({ name }) => name.includes('Sathyamoorthy'))?.id)
})
