import { useId, useState, type FocusEvent, type KeyboardEvent } from 'react'
import type { StaffMember } from './models'
import './teacher-selector.css'

interface TeacherSelectorProps {
  staff: StaffMember[]
  value: string
  onChange: (teacherId: string) => void
  ariaLabel: string
  className?: string
  placeholder?: string
}

export function TeacherSelector({ staff, value, onChange, ariaLabel, className = '', placeholder = 'Search by teacher name or ID' }: TeacherSelectorProps) {
  const selectorId = useId().replaceAll(':', '')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const selectedStaff = staff.find((person) => person.id === value)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchingStaff = staff.filter((person) => !normalizedQuery
    || person.name.toLocaleLowerCase().includes(normalizedQuery)
    || person.id.toLocaleLowerCase().includes(normalizedQuery))

  const choose = (teacherId: string) => {
    onChange(teacherId)
    setQuery('')
    setEditing(false)
    setOpen(false)
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setQuery('')
    setEditing(false)
    setOpen(false)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((current) => Math.min(current + 1, matchingStaff.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex((current) => Math.max(current - 1, 0))
    } else if (event.key === 'Enter' && open) {
      event.preventDefault()
      choose(activeIndex === 0 ? '' : matchingStaff[activeIndex - 1]?.id ?? '')
    } else if (event.key === 'Escape') {
      setQuery('')
      setEditing(false)
      setOpen(false)
    }
  }

  return <div className={`teacher-selector ${className}`} onBlur={handleBlur}>
    <input
      type="text"
      role="combobox"
      aria-label={ariaLabel}
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={`${selectorId}-options`}
      aria-activedescendant={open ? `${selectorId}-option-${activeIndex}` : undefined}
      autoComplete="off"
      placeholder={placeholder}
      value={editing ? query : selectedStaff ? `${selectedStaff.id} — ${selectedStaff.name}` : ''}
      onFocus={() => { setEditing(true); setQuery(''); setActiveIndex(0); setOpen(true) }}
      onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); setOpen(true) }}
      onKeyDown={handleKeyDown}
    />
    {open && <div className="teacher-selector-options" id={`${selectorId}-options`} role="listbox" aria-label={`${ariaLabel} matches`}>
      <div
        id={`${selectorId}-option-0`}
        className={`teacher-selector-option${activeIndex === 0 ? ' active' : ''}`}
        role="option"
        aria-selected={!value}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveIndex(0)}
        onClick={() => choose('')}
      >Select staff</div>
      {matchingStaff.map((person, index) => <div
        id={`${selectorId}-option-${index + 1}`}
        className={`teacher-selector-option${activeIndex === index + 1 ? ' active' : ''}`}
        role="option"
        aria-selected={person.id === value}
        key={person.id}
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={() => setActiveIndex(index + 1)}
        onClick={() => choose(person.id)}
      >{person.id} — {person.name}</div>)}
      {matchingStaff.length === 0 && <div className="teacher-selector-empty" role="status">No matching staff</div>}
    </div>}
  </div>
}