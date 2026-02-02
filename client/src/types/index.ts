// input weightages
export interface Weightages {
  preference: number;
  seniority: number;
  elective_shortfall_penalty: number;
  core_shortfall_penalty: number;
}

// api response types
export interface ApiResponse {
  success: boolean;
  residents: Resident[];
  resident_history: ResidentHistory[];
  resident_preferences: ResidentPreference[];
  resident_sr_preferences: ResidentSrPreference[];
  chosen_sr_by_resident: Record<string, string>;
  postings: Posting[];
  statistics: Statistics;
}

export interface Resident {
  mcr: string;
  name: string;
  resident_year: number;
  career_blocks_completed: number | null; // number of blocks completed to date
  core_blocks_completed: {
    [key: string]: number;
  };
  unique_electives_completed: string[];
  ccr_status: {
    completed: boolean;
    posting_code: string;
  };
  warnings: Warning[];
}

export interface Warning {
  code: string;
  description: string;
}

export interface ResidentHistory {
  mcr: string;
  year: number;
  month_block: number; // block number within the year (1-12)
  career_block: number; // block number in career (1-36)
  posting_code: string;
  is_current_year: boolean;
  is_leave: boolean;
  leave_type: string;
}

export interface PinnedAssignment {
  mcr: string;
  month_block: number;
  posting_code: string;
};

export interface PinnedAssignmentsByResident {
  [mcr: string]: PinnedAssignment[];
};

export interface ResidentPreference {
  mcr: string;
  preference_rank: number;
  posting_code: string;
}

export interface ResidentSrPreference {
  mcr: string;
  preference_rank: number;
  base_posting: string;
}

export interface Posting {
  posting_code: string;
  posting_type: string;
  max_residents: number;
  required_block_duration: number;
}

export interface Statistics {
  total_residents: number;
  cohort: {
    optimisation_scores: number[];
    optimisation_scores_normalised: number[];
    posting_util: PostingUtil[];
    elective_preference_satisfaction: ElectivePreferenceSatisfaction;
  };
}

export interface ElectivePreferenceSatisfaction {
  "1st_choice": number;
  "2nd_choice": number;
  "3rd_choice": number;
  "4th_choice": number;
  "5th_choice": number;
  none_met: number;
  no_preference: number;
}

export interface PostingUtil {
  posting_code: string;
  util_per_block: UtilPerBlock[];
}

export interface UtilPerBlock {
  month_block: number;
  filled: number;
  capacity: number;
  is_over_capacity: boolean;
}

// csv file types
export interface CsvFilesState {
  residents: File | null;
  resident_history: File | null;
  resident_preferences: File | null;
  postings: File | null;
}

// generation of sample csv
export interface CsvRow {
  [key: string]: string | number;
}

export type MonthView = "ALL" | "FIRST_6" | "LAST_6";
