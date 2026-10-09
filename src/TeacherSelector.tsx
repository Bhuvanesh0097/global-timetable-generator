import { useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { StaffMember } from './models'
import './teacher-selector.css'

interface DropdownPosition {
  top: number
  left: number
  width: number
  maxHeight: number
}

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
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const optionsRef = useRef<HTMLDivElement | null>(null)
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
    inputRef.current?.blur()
  }

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') {
      setDropdownPosition(null)
      return
    }

    const input = inputRef.current
    if (!input) return

    const updatePosition = () => {
      const bounds = input.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      if (bounds.bottom <= 0 || bounds.top >= viewportHeight) {
        setDropdownPosition(null)
        return
      }

      const width = Math.min(bounds.width, Math.max(0, viewportWidth - 16))
      const left = Math.min(Math.max(bounds.left, 8), Math.max(8, viewportWidth - width - 8))
      const spaceBelow = Math.max(0, viewportHeight - bounds.bottom - 8)
      const spaceAbove = Math.max(0, bounds.top - 8)
      const openAbove = spaceBelow < 120 && spaceAbove > spaceBelow
      const availableHeight = openAbove ? spaceAbove : spaceBelow
      const maxHeight = Math.min(220, availableHeight)
      const menuHeight = Math.min(optionsRef.current?.getBoundingClientRect().height ?? maxHeight, maxHeight)
      const top = openAbove ? bounds.top - menuHeight - 2 : bounds.bottom + 2

      setDropdownPosition({ top, left, width, maxHeight })
    }

    updatePosition()
    const frame = window.requestAnimationFrame(updatePosition)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    window.visualViewport?.addEventListener('resize', updatePosition)
    window.visualViewport?.addEventListener('scroll', updatePosition)

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition)
    observer?.observe(input)

    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      window.visualViewport?.removeEventListener('resize', updatePosition)
      window.visualViewport?.removeEventListener('scroll', updatePosition)
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [open, normalizedQuery, matchingStaff.length])

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && (
      event.currentTarget.contains(event.relatedTarget)
      || optionsRef.current?.contains(event.relatedTarget)
    )) return
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
      event.preventDefault()
      setOpen(false)
    }
  }

  const options = open && dropdownPosition && typeof document !== 'undefined'
    ? createPortal(<div
        ref={optionsRef}
        className="teacher-selector-options"
        id={`${selectorId}-options`}
        role="listbox"
        aria-label={`${ariaLabel} matches`}
        style={{
          top: dropdownPosition.top,
          left: dropdownPosition.left,
          width: dropdownPosition.width,
          maxHeight: dropdownPosition.maxHeight,
        }}
      >
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
      </div>, document.body)
    : null

  return <div className={`teacher-selector ${className}`} onBlur={handleBlur}>
    <input
      ref={inputRef}
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
    {options}
  </div>
}
