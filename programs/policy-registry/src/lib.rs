use anchor_lang::prelude::*;

declare_id!("7XT3UzsbuaPU9KsecRpC9EsGP7sX8QKuxPPgUtxFk1Pn");

#[program]
pub mod policy_registry {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        max_ltv_bps: u16,
        mint_cap_usd: u64,
    ) -> Result<()> {
        let state = &mut ctx.accounts.policy_state;
        state.admin = ctx.accounts.admin.key();
        state.paused = false;
        state.max_ltv_bps = max_ltv_bps;
        state.mint_cap_usd = mint_cap_usd;
        state.version = 1;
        state.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    pub fn apply_policy(
        ctx: Context<ApplyPolicy>,
        paused: bool,
        max_ltv_bps: u16,
        mint_cap_usd: u64,
    ) -> Result<()> {
        let state = &mut ctx.accounts.policy_state;
        require_keys_eq!(
            state.admin,
            ctx.accounts.admin.key(),
            CustomError::Unauthorized
        );
        state.paused = paused;
        state.max_ltv_bps = max_ltv_bps;
        state.mint_cap_usd = mint_cap_usd;
        state.version = state.version.checked_add(1).unwrap();
        state.updated_at = Clock::get()?.unix_timestamp;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + PolicyState::LEN,
        seeds = [b"policy-state", admin.key().as_ref()],
        bump
    )]
    pub policy_state: Account<'info, PolicyState>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyPolicy<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        seeds = [b"policy-state", admin.key().as_ref()],
        bump
    )]
    pub policy_state: Account<'info, PolicyState>,
}

#[account]
pub struct PolicyState {
    pub admin: Pubkey,    // 32
    pub paused: bool,     //  1
    pub max_ltv_bps: u16, //  2
    pub mint_cap_usd: u64,//  8
    pub version: u64,     //  8
    pub updated_at: i64,  //  8
}

impl PolicyState {
    pub const LEN: usize = 32 + 1 + 2 + 8 + 8 + 8; // = 59
}

#[error_code]
pub enum CustomError {
    #[msg("Caller is not the registered admin")]
    Unauthorized,
}
