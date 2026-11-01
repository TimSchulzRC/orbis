import {
  StickyNote, Map as MapIcon, FolderKanban, CircleCheck, Book, User, PenLine, GraduationCap, Building2, FileText, Star, Heart,
  Lightbulb, Calendar, Flag, Bookmark, Briefcase, House, Music, Film, Globe, Code, Coffee, Camera, Users, Target, Layers, Box,
  Leaf, Rocket, MessageCircle, Link, Circle, Inbox, Image, FileType2, FileAudio, FileVideo, File, Shapes, Paperclip, ListTodo, Archive,
  type LucideIcon,
} from "lucide-react";

/** Keys are stored in the data, so never rename them (see @obtion/core/palette). */
export const ICON: Record<string, LucideIcon> = {
  "sticky-note": StickyNote,
  map: MapIcon,
  "folder-kanban": FolderKanban,
  "circle-check": CircleCheck,
  book: Book,
  user: User,
  "pen-line": PenLine,
  "graduation-cap": GraduationCap,
  "building-2": Building2,
  "file-text": FileText,
  star: Star,
  heart: Heart,
  lightbulb: Lightbulb,
  calendar: Calendar,
  flag: Flag,
  bookmark: Bookmark,
  briefcase: Briefcase,
  house: House,
  music: Music,
  film: Film,
  globe: Globe,
  code: Code,
  coffee: Coffee,
  camera: Camera,
  users: Users,
  target: Target,
  layers: Layers,
  box: Box,
  leaf: Leaf,
  rocket: Rocket,
  "message-circle": MessageCircle,
  link: Link,
  circle: Circle,
  inbox: Inbox,
  image: Image,
  paperclip: Paperclip,
  "list-todo": ListTodo,
  archive: Archive,
};

export const INBOX_ICON = Inbox;
// a lined sheet – a notebook read as "several entries", and the plain sheet is taken by documents
export const NOTE_ICON = FileText;
export const OVERVIEW_ICON = MapIcon;
export const TYPE_ICON = Shapes;
export const FILE_ICONS: Record<string, LucideIcon> = { bild: Image, pdf: FileType2, audio: FileAudio, video: FileVideo, dokument: File, sonstiges: File };
export const FILES_ICON = Paperclip;
